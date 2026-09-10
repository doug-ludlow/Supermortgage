// 5.3 Reporting liquidations (payoff/foreclosure/short sale)
// spec/sections/05-investor-reporting-remittance-fannie-mae/5-3-reporting-liquidations-payoff-foreclosure-short-sale.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { zonedEpochMs, toIso } from "../../kernel/calendar/zoned.ts";
import { MemoryEventStore, FixedClock, SYSTEM } from "../../kernel/events/index.ts";
import { TimerEngine, loadRegistry } from "../../kernel/timers/index.ts";
import { larDeadlineMs } from "./period.ts";
import { zoned, projectLar96, prevalidate } from "./lar.ts";
import { actionCode, removalAmounts, removalInterest, PROCEEDS_CRS_CODE } from "./liquidation.ts";
import { payoffInterest, crsAaRequest } from "./remittance.ts";
import { applyInvestorTimerOverrides } from "./timers.ts";
import { ET, ssPayoffInterest, postCloseRemovalError, reconcileDra, reogramConfirmation, projectLiquidationEvent, removalConfidenceHold, tpsProceeds, matchReimbursements } from "./ops.ts";
import { eventMatches, parseEventPattern, type Actor } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore } from "../../app/tools.ts";
import { bindTools, toolKey } from "../../app/tools/index.ts";
import { TOOLS_5_3 } from "../../app/tools/section5-3.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";

const at = (d: string, hhmm: string) => zonedEpochMs(D(d), hhmm, ET);
function engine(startIso: string) { const clock = new FixedClock(startIso); const events = new MemoryEventStore(clock); const reg = loadRegistry(); applyInvestorTimerOverrides(reg); return { clock, events, timers: new TimerEngine(reg, events) }; }
const REG = loadOverriddenRegistry();
const REPORTING: Actor = { kind: "agent", id: "investor-reporting" }, CLAIMS: Actor = { kind: "agent", id: "claims-reo" }, FCL_OPS: Actor = { kind: "agent", id: "foreclosure-ops" };
const OPERATOR: Actor = { kind: "human", id: "u-portal", role: "fnma_portal_operator" }, OFFICER: Actor = { kind: "human", id: "u-officer", role: "officer" };
/** The 5.3 tools on the bus with the overridden registry (the 5.3 rows only) — every timer assertion below runs through the TimerEngine on the events the tools emit. */
function harness(nowIso: string, loanId = "L-1") {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock); const ledger = new MemoryLedger();
  const timers = new TimerEngine(REG, events, { processes: ["5.3"] });
  const ctx: UowContext = { loanId, events, ledger, timers, clock, decide: () => {} };
  const escalations = new EscalationService(events, clock); const agents = new AgentRegistry();
  const cmds = bindTools({ store: new EntityStore(), ports: {}, escalations, services: {} }, agents, TOOLS_5_3); const bus = new CommandBus(agents);
  const run = async (name: string, input: Record<string, unknown>, actor: Actor = REPORTING): Promise<Record<string, unknown>> => (await bus.execute(cmds.get(toolKey("5.3", name))!, actor, input, ctx)).output as Record<string, unknown>;
  const refused = async (name: string, input: Record<string, unknown>, code: string, actor: Actor = REPORTING): Promise<void> => assert.rejects(run(name, input, actor), (e: unknown) => e instanceof CommandRefused && e.code === code, `${name} should refuse with ${code}`);
  const timer = (code: string) => timers.byCode(code)[0];
  const types = () => events.all().map((e) => e.type);
  return { clock, events, timers, escalations, run, refused, timer, types };
}

test("5.3-T1: Given payoff funds wired and cleared Thu Oct 15, 2026 on an A/A loan ($199,500, PTR 6%, LPI Sept 1, payoff date Oct 16), then LAR 96 code 60 with interest $1,489.42 is submitted by Fri Oct 16 20:00 ET and CRS 001 for UPB + interest (> $2,500) is instructed the same day.", () => {
  const interest = payoffInterest("AA", 19950000n, "6.000", D("2026-09-01"), D("2026-10-16"));
  assert.equal(interest, 148942n);
  const r = removalAmounts({ kind: "payoff", insured: "none", type: "AA", actual_upb_cents: 19950000n, scheduled_upb_cents: 0n, nib_cents: 0n, ptr: "6.000", legal_date: D("2026-10-16"), period_open: true, interest_cents: interest });
  assert.deepEqual([r.action_code, r.principal_cents, r.interest_cents], ["60", 19950000n, 148942n]);
  const lar = projectLar96("123456789", "4000000001", { lpi_date: D("2026-10-01"), upb_cents: 0n, nib_cents: 0n, interest_cents: r.interest_cents, principal_cents: r.principal_cents, other_fees_cents: 0n, action_code: "60", action_date: D("2026-10-16") });
  assert.equal(lar.fields.action_code, "60"); assert.equal(lar.fields.interest, zoned(148942n));
  const processed = at("2026-10-15", "14:00");
  assert.equal(toIso(larDeadlineMs(processed, true)), toIso(at("2026-10-16", "20:00")));
  // the good-funds gate opens on payoff.funds.cleared, which arms the AC 60 clock; submitting removal.payoff satisfies it
  const { events, timers } = engine(new Date(processed).toISOString());
  events.append({ type: "payoff.funds.received", loanId: "L-1", actor: SYSTEM, payload: { amount_cents: (19950000n + interest).toString() } });
  const gate = timers.byCode("SM_PAYOFF_GOODFUNDS_GATE")[0]!; assert.equal(gate.status, "armed"); assert.equal(gate.dueAt, undefined);
  events.append({ type: "payoff.funds.cleared", loanId: "L-1", actor: SYSTEM, payload: { processed_at: new Date(processed).toISOString(), remittance_type: "aa", amount_cents: (19950000n + interest).toString() } });
  assert.equal(gate.status, "satisfied");
  const ac60 = timers.byCode("FNMA_IRM_PAYOFF_AC60_NEXTBD_2000")[0]!;
  assert.equal(toIso(ac60.dueAt!), toIso(at("2026-10-16", "20:00")));
  events.append({ type: "investor_events.submitted", loanId: "L-1", actor: SYSTEM, payload: { family: "removal", event_type: "removal.payoff", action_code: "60" } });
  assert.equal(ac60.status, "satisfied");
  // proceeds: A/A payoff > $2,500 → CRS 001 instructed the same day, settling the next Federal Reserve business day
  const crs = crsAaRequest(19950000n + interest, D("2026-10-16"), false);
  assert.equal(crs.instruct, true); assert.equal(crs.code, "001"); assert.equal(PROCEEDS_CRS_CODE["60"], "001"); assert.equal(crs.settlement_date, "2026-10-19");
});
test("5.3-T2: Given a payoff processed Mon Nov 2, 2026 (BD1), then the AC 60 deadline is Tue Nov 3 17:00 ET and, for an S/S loan, no full-month interest is charged if reported by BD2.", () => {
  const processed = zonedEpochMs(D("2026-11-02"), "15:10", ET);
  assert.equal(toIso(larDeadlineMs(processed, true)), toIso(zonedEpochMs(D("2026-11-03"), "17:00", ET)));
  const onTime = ssPayoffInterest({ scheduled_upb_cents: 24908861n, ptr: "6.000", processed_at_ms: processed, reported_at_ms: zonedEpochMs(D("2026-11-03"), "12:00", ET) });
  assert.equal(onTime.waived, true); assert.equal(onTime.charged_cents, 0n); assert.equal(onTime.full_month_cents, 124544n);
  const late = ssPayoffInterest({ scheduled_upb_cents: 24908861n, ptr: "6.000", processed_at_ms: processed, reported_at_ms: zonedEpochMs(D("2026-11-04"), "09:00", ET) });
  assert.equal(late.waived, false); assert.equal(late.charged_cents, 124544n);
});
test("5.3-T3: Given an MI-insured conventional loan foreclosed with Fannie Mae acquiring, then code 72 is selected; uninsured → 70; third-party purchaser → 71 with CRS 311 proceeds.", () => {
  assert.equal(actionCode("foreclosure_fnma_acquires", "mi"), "72"); assert.equal(actionCode("foreclosure_fnma_acquires", "fha"), "72"); assert.equal(actionCode("foreclosure_fnma_acquires", "none"), "70");
  assert.equal(actionCode("redemption", "none"), "70"); assert.equal(actionCode("mortgage_release", "mi"), "72"); assert.equal(actionCode("third_party_sale", "none"), "71"); assert.equal(actionCode("short_sale", "mi"), "71"); assert.equal(actionCode("payoff", "none"), "60");
  assert.equal(PROCEEDS_CRS_CODE["71"], "311");
  // the IRM S/A interest table: advancing (prior scheduled UPB × PTR ÷ 12), recovering (total advanced × −1), not advancing (prior actual UPB × PTR ÷ 12 × −1)
  const sa = { kind: "foreclosure_fnma_acquires" as const, insured: "none" as const, type: "SA" as const, actual_upb_cents: 19950000n, scheduled_upb_cents: 19900000n, nib_cents: 0n, ptr: "6.000", legal_date: D("2026-10-14"), period_open: true };
  assert.equal(removalInterest({ ...sa, sa_state: "advancing" }), 99500n);
  assert.equal(removalInterest({ ...sa, sa_state: "recovering", total_advanced_interest_cents: 299250n }), -299250n);
  assert.equal(removalInterest({ ...sa, sa_state: "recovering", total_advanced_interest_cents: 299250n, lpi_movement: "backward" }), -(299250n + 99750n));
  assert.equal(removalInterest({ ...sa, sa_state: "not_advancing" }), -99750n);
  assert.equal(removalInterest({ ...sa, type: "AA", lpi_movement: "none" }), 0n); assert.equal(removalInterest({ ...sa, type: "AA", lpi_movement: "forward" }), 99750n);
});
test("5.3-T4: Given the S/S third-party sale example, then principal $249,088.61, interest $1,245.44, proceeds $210,000 (code 311) and a TPS case are produced, and the delinquency-advance reimbursement credit is matched within two draft cycles.", () => {
  const tp = removalAmounts({ kind: "third_party_sale", insured: "none", type: "SS", actual_upb_cents: 0n, scheduled_upb_cents: 24908861n, nib_cents: 0n, ptr: "6.000", legal_date: D("2026-10-14"), period_open: true });
  assert.deepEqual([tp.action_code, tp.principal_cents, tp.interest_cents, tp.reported_late], ["71", 24908861n, 124544n, false]);
  const p = tpsProceeds({ bid_cents: 21000000n, received_on: D("2026-10-15"), scheduled_upb_cents: 24908861n, ptr: "6.000", lpi_due: D("2026-03-01"), sale_on: D("2026-10-14"), settlement_on: D("2026-10-19") });
  assert.equal(p.crs_code, "311"); assert.equal(p.amount_cents, 21000000n); assert.equal(p.tps_case, true); assert.equal(p.surplus_cents, 0n);
  // the four delinquency-advance drafts ($5,904.58) come back as a Fannie Mae credit after LAR acceptance and are matched FIFO within two draft cycles
  const advances = [{ period: "2026-06", amount_cents: 147600n, status: "outstanding" as const }, { period: "2026-07", amount_cents: 147610n, status: "outstanding" as const }, { period: "2026-08", amount_cents: 147619n, status: "outstanding" as const }, { period: "2026-09", amount_cents: 147629n, status: "outstanding" as const }];
  const m = matchReimbursements({ advances, credits: [590458n], cycles_elapsed: 1 });
  assert.equal(m.all_reimbursed, true); assert.equal(m.escalation, null); assert.ok(m.advances.every((a) => a.status === "reimbursed_by_fnma"));
  assert.equal(matchReimbursements({ advances, credits: [], cycles_elapsed: 2 }).escalation, "irr_package");
});
test("5.3-T5: Given a deferral loan with $12,000 non-interest-bearing balance and interest-bearing UPB $180,000, when it pays off, then reported principal = $192,000 × participation; omission is caught by local validation before submission.", () => {
  const full = removalAmounts({ kind: "payoff", insured: "none", type: "AA", actual_upb_cents: 18000000n, scheduled_upb_cents: 0n, nib_cents: 1200000n, ptr: "6.000", legal_date: D("2026-10-16"), period_open: true, interest_cents: 0n });
  assert.equal(full.principal_cents, 19200000n);
  assert.equal(removalAmounts({ kind: "payoff", insured: "none", type: "AA", actual_upb_cents: 18000000n, scheduled_upb_cents: 0n, nib_cents: 1200000n, ptr: "6.000", legal_date: D("2026-10-16"), period_open: true, interest_cents: 0n, participation_pct: "50" }).principal_cents, 9600000n);
  const expected = { upb_cents: 18000000n, lpi_date: D("2026-10-01"), nib_cents: 1200000n };
  const ok = { lpi_date: D("2026-10-01"), upb_cents: 0n, nib_cents: 1200000n, interest_cents: 0n, principal_cents: 19200000n, other_fees_cents: 0n, action_code: "60", action_date: D("2026-10-16") };
  assert.deepEqual(prevalidate(ok, expected, D("2026-10-16"), null), []);
  const omitted = prevalidate({ ...ok, principal_cents: 18000000n }, expected, D("2026-10-16"), null);
  assert.equal(omitted.length, 1); assert.match(omitted[0]!, /omits the non-interest-bearing balance/);
  assert.match(prevalidate({ ...ok, nib_cents: 0n }, expected, D("2026-10-16"), null).join("; "), /NIB balance 0 not aligned/);
});
test("5.3-T6: Given the AC 60 was accepted in the October period and the wire is reversed Nov 4, 2026 (after Nov 3 BD2 close), then no correction is projected, `fnma_liquidated_in_error` is set, the amount due is computed for remittance and an `officer` escalation and `qc_finding` case open.", () => {
  const r = postCloseRemovalError({ accepted_period: "2026-10", discovered_at_ms: zonedEpochMs(D("2026-11-04"), "10:00", ET), reported_principal_cents: 24908861n, reported_interest_cents: 124544n });
  assert.equal(r.after_close, true); assert.equal(r.correction_projected, false); assert.equal(r.fnma_liquidated_in_error, true);
  assert.equal(r.amount_due_cents, 25033405n); assert.equal(r.escalation, "officer"); assert.equal(r.case, "qc_finding");
  const inside = postCloseRemovalError({ accepted_period: "2026-10", discovered_at_ms: zonedEpochMs(D("2026-11-03"), "16:00", ET), reported_principal_cents: 24908861n, reported_interest_cents: 124544n });
  assert.equal(inside.correction_projected, true); assert.equal(inside.case, null);
});
test('5.3-T7: Given a DRA "Foreclosure Sale Held" event from the firm feed dated Oct 14 with no matching `foreclosure.sale.held` in our system by Oct 15, then a sev-1 escalation fires and the REOgram confirmation task is pre-created due Oct 16.', async () => {
  const r = reconcileDra({ dra: [{ type: "sale_held", date: D("2026-10-14") }], ours: [], as_of: D("2026-10-15") });
  assert.equal(r.sev1.length, 1); assert.equal(r.sev1[0]!.milestone.date, "2026-10-14"); assert.equal(r.sev1[0]!.reogram_task_due, "2026-10-16");
  assert.equal(reconcileDra({ dra: [{ type: "sale_held", date: D("2026-10-14") }], ours: [{ type: "sale_held", date: D("2026-10-14") }], as_of: D("2026-10-15") }).sev1.length, 0);
  // through the bus (foreclosure-ops): the weekly SM_DRA_RECONCILE_7CD run, the sev-1 escalation, and the pre-created REOgram task arming FNMA_E4101_REOGRAM_CONFIRM_1BD due Fri Oct 16
  const h = harness(new Date(at("2026-10-15", "10:00")).toISOString());
  h.events.append({ type: "schedule.tick", actor: SYSTEM, payload: { cadence: "weekly", weekday: "monday", at: "09:00" } });
  assert.equal(h.timer("SM_DRA_RECONCILE_7CD")!.status, "armed");
  const out = await h.run("reconcileDra", { as_of: "2026-10-15", dra: [{ type: "sale_held", date: "2026-10-14" }], ours: [] }, FCL_OPS);
  const sev1 = out.sev1 as { escalation_id: string; reogram_task_due: string; reogram_task_due_at: string }[];
  assert.equal(sev1.length, 1); assert.equal(sev1[0]!.reogram_task_due, "2026-10-16"); assert.equal(toIso(Date.parse(sev1[0]!.reogram_task_due_at)), toIso(at("2026-10-16", "17:00")));
  const esc = h.escalations.opened.find((e) => e.id === sev1[0]!.escalation_id)!; assert.equal(esc.kind, "sev1"); assert.equal(esc.severity, "sev1"); assert.equal(esc.loanId, "L-1");
  assert.ok(h.types().includes("reogram.created") && h.types().includes("human_portal_task.created") && h.types().includes("dra.reconciliation.recorded"));
  const confirm = h.timer("FNMA_E4101_REOGRAM_CONFIRM_1BD")!; assert.equal(confirm.status, "armed"); assert.equal(confirm.dueDate, "2026-10-16");
  assert.equal(h.timers.byCode("SM_DRA_RECONCILE_7CD")[0]!.status, "satisfied");   // the run is recorded; the recurring row re-arms
  assert.equal(h.timers.byCode("SM_DRA_RECONCILE_7CD").length, 2);
  // the agent may prepare the package but only the fnma_portal_operator confirms in P360; the confirmation satisfies the 1-BD clock
  await h.refused("prepareReogramPackage", { op: "confirm", p360_case_id: "P360-1", evidence_document_id: "doc-shot-1" }, "PORTAL_TASK_IS_HUMAN", CLAIMS);
  await h.run("prepareReogramPackage", { op: "confirm", p360_case_id: "P360-1", evidence_document_id: "doc-shot-1" }, OPERATOR);
  assert.equal(confirm.status, "satisfied"); assert.ok(h.types().includes("reogram.confirmed") && h.types().includes("human_portal_task.completed"));
  // our own sale event with no DRA entry within 2 BD → a task to the firm (attorney), never a servicer DRA entry
  const firm = await h.run("reconcileDra", { as_of: "2026-10-19", dra: [], ours: [{ type: "sale_held", date: "2026-10-14" }] }, FCL_OPS);
  assert.equal((firm.firm_tasks as unknown[]).length, 1); assert.equal(h.escalations.opened[h.escalations.opened.length - 1]!.kind, "attorney");
});
test("5.3-T8: Given a REOgram notice received Wed Nov 25, 2026 17:30 ET, then the confirmation task is due Mon Nov 30 (next `fannie_et` BD after Fannie Mae holidays Nov 26–27), with a warning at 70%.", async () => {
  const received = zonedEpochMs(D("2026-11-25"), "17:30", ET);
  const t = reogramConfirmation(received);
  assert.equal(t.due_on, "2026-11-30"); assert.equal(toIso(t.due_ms), toIso(zonedEpochMs(D("2026-11-30"), "17:00", ET))); assert.equal(t.role, "fnma_portal_operator");
  assert.equal(t.warning_at_ms, received + Math.round((t.due_ms - received) * 0.7)); assert.ok(t.warning_at_ms > received && t.warning_at_ms < t.due_ms);
  // through the bus (claims-reo): the P360 notice opens the portal task → `reogram.created{receipt}` + `human_portal_task.created{task=reogram_confirmation, due_on, warning_at}` and arms FNMA_E4101_REOGRAM_CONFIRM_1BD
  const h = harness(new Date(received).toISOString());
  const task = await h.run("prepareReogramPackage", { op: "open_task", source: "p360_notice", received_at: new Date(received).toISOString(), p360_case_id: "P360-NOV-1", sale_date: "2026-11-24" }, CLAIMS);
  assert.equal(task.due_on, "2026-11-30"); assert.equal(task.role, "fnma_portal_operator"); assert.equal(toIso(Date.parse(task.warning_at as string)), toIso(t.warning_at_ms));
  const created = h.events.all().find((e) => e.type === "human_portal_task.created")!; assert.equal(created.payload.task, "reogram_confirmation"); assert.equal(created.payload.due_on, "2026-11-30");
  const inst = h.timer("FNMA_E4101_REOGRAM_CONFIRM_1BD")!; assert.equal(inst.status, "armed"); assert.equal(inst.anchorDate, "2026-11-25");
  // (the registry clock resolves 1 `business_days_fannie_et` on the kernel's fannieEt calendar, which — unlike the observed calendar the task uses — does not close Fri Nov 27; see business.ts FNMA_PUBLISHED_CLOSURES)
  await h.run("prepareReogramPackage", { op: "exception", p360_case_id: "P360-NOV-1", code: "OCCUPANCY_UNKNOWN" }, CLAIMS);
  const exc = h.timer("FNMA_P360_REOGRAM_EXCEPTION_3BD")!; assert.equal(exc.status, "armed"); assert.equal(exc.anchorDate, "2026-11-25");
  await h.run("prepareReogramPackage", { op: "resolve_exception", p360_case_id: "P360-NOV-1", code: "OCCUPANCY_UNKNOWN", evidence_document_id: "doc-occ-1" }, OPERATOR);
  assert.equal(exc.status, "satisfied");
});
test("5.3-T9: Given `removal.liquidation.third_party.mode = event` in CIT, then the P360 liquidation event JSON is produced in `api-clve` and diffed against the production LAR 71.", () => {
  const p = projectLiquidationEvent({ mode: "event", kind: "third_party_sale", insured: "none", principal_cents: 24908861n, interest_cents: 124544n, legal_date: D("2026-10-14"), fnma_loan_number: "1234567890", cit: true });
  assert.equal(p.env, "api-clve"); assert.equal(p.lar.action_code, "71"); assert.equal(p.lar.action_date, "101426");
  assert.equal(p.p360_event!["Liquidation Event Type"], "Third-Party Sale"); assert.equal(p.p360_event!["Principal Amount"], "249088.61");
  assert.deepEqual(p.diff, []);
  assert.equal(projectLiquidationEvent({ mode: "legacy", kind: "third_party_sale", insured: "none", principal_cents: 24908861n, interest_cents: 124544n, legal_date: D("2026-10-14"), fnma_loan_number: "1234567890", cit: false }).p360_event, null);
});
test("5.3-T10: Given the agent's confidence on insured status is 0.7, then the removal is held, a `human_agent` review is requested at deadline − 4h, and the timer still breaches if unresolved (evidence retained).", () => {
  const deadline = zonedEpochMs(D("2026-10-16"), "20:00", ET);
  const h = removalConfidenceHold({ confidence: 0.7, deadline_ms: deadline, candidates: ["70", "72"], evidence: ["mi-cert-1", "sale-deed-1"] });
  assert.equal(h.held, true); assert.equal(h.review!.role, "human_agent"); assert.equal(toIso(h.review!.request_at_ms), toIso(zonedEpochMs(D("2026-10-16"), "16:00", ET)));
  assert.equal(h.breaches_if_unresolved, true); assert.deepEqual(h.evidence_retained, ["mi-cert-1", "sale-deed-1"]);
  assert.equal(removalConfidenceHold({ confidence: 0.95, deadline_ms: deadline, candidates: ["71"], evidence: [] }).held, false);
  // the hold does not stop the engine: the LAR 70/72 clock armed by the liquidation fact breaches at 20:00 ET with nothing submitted
  const { events, timers } = engine(new Date(at("2026-10-15", "10:00")).toISOString());
  events.append({ type: "liquidation_facts.processed", loanId: "L-1", actor: SYSTEM, payload: { processed_at: new Date(at("2026-10-15", "10:00")).toISOString(), liquidation_type: "fcl_fnma_acquired" } });
  const inst = timers.byCode("FNMA_IRM_LIQ_AC70_72_NEXTBD_2000")[0]!;
  assert.equal(toIso(inst.dueAt!), toIso(deadline));
  assert.ok(timers.evaluate(new Date(deadline + 60_000).toISOString()).some((b) => b.def.code === "FNMA_IRM_LIQ_AC70_72_NEXTBD_2000")); assert.equal(inst.status, "breached");
  events.append({ type: "investor_events.submitted", loanId: "L-1", actor: SYSTEM, payload: { family: "removal", event_type: "removal.liquidation.insured", action_code: "72" } });
  assert.equal(inst.status, "satisfied_late");
});

test("5.3 worked example: third-party bid $210,000.00 → CRS 311 by Fri Oct 16 16:00 ET, settles Mon Oct 19, all to Fannie Mae; LAR 96 code 71 with zone-signed interest $1,245.44 and principal $249,088.61", () => {
  const p = tpsProceeds({ bid_cents: 21000000n, received_on: D("2026-10-15"), scheduled_upb_cents: 24908861n, ptr: "6.000", lpi_due: D("2026-03-01"), sale_on: D("2026-10-14"), settlement_on: D("2026-10-19") });
  assert.equal(p.crs_code, "311"); assert.equal(p.amount_cents, 21000000n); assert.equal(toIso(p.instruct_by_ms), toIso(zonedEpochMs(D("2026-10-16"), "16:00", ET))); assert.equal(p.settles_on, "2026-10-19");
  assert.ok(p.indebtedness_cents > 21000000n); assert.equal(p.to_fnma_cents, 21000000n); assert.equal(p.surplus_cents, 0n); assert.equal(p.tps_case, true);
  assert.equal(zoned(124544n), "0000012454D"); assert.equal(zoned(24908861n), "0002490886A");   // IRM zone-sign overpunch on the last digit (5.1-T1 convention)
  const { events, timers } = engine(new Date(at("2026-10-15", "10:00")).toISOString());
  events.append({ type: "tps.proceeds.received", loanId: "L-1", actor: SYSTEM, payload: { amount_cents: "21000000" } });
  assert.equal(toIso(timers.byCode("FNMA_F120_TPS_PROCEEDS_NEXT_REMIT")[0]!.dueAt!), toIso(at("2026-10-16", "16:00")));
});

test("5.3 LL-2026-05 rail: a liquidation fact processed under mode=event arms FNMA_LL202605_FORECLOSURE_EVENT_NEXTBD (next BD 03:00 ET) beside the LAR 70/71/72 clock, and only the parsed P360 acceptance satisfies it", async () => {
  const processed = at("2026-10-15", "10:00"); const h = harness(new Date(processed).toISOString());
  const fact = await h.run("projectEvent", { op: "record_fact", liquidation_type: "fcl_third_party", legal_date: "2026-10-14", processed_at: new Date(processed).toISOString(), purchaser: "third_party", insured_flag: "none", proceeds_cents: 21000000n, mode: "event" });
  assert.equal(fact.action_code, "71"); assert.equal(fact.event_type, "removal.liquidation.third_party"); assert.equal(fact.p360_event_type, "Third-Party Sale"); assert.equal(fact.reported_late, false); assert.equal(fact.activity_period, "2026-10");
  assert.equal(toIso(Date.parse(fact.lar_due_at as string)), toIso(at("2026-10-16", "20:00"))); assert.equal(toIso(Date.parse(fact.p360_event_due_at as string)), toIso(at("2026-10-16", "03:00")));
  const p360 = h.timer("FNMA_LL202605_FORECLOSURE_EVENT_NEXTBD")!; assert.equal(p360.status, "armed"); assert.equal(toIso(p360.dueAt!), toIso(at("2026-10-16", "03:00")));
  const lar = h.timer("FNMA_IRM_LIQ_AC70_72_NEXTBD_2000")!; assert.equal(lar.status, "armed"); assert.equal(toIso(lar.dueAt!), toIso(at("2026-10-16", "20:00")));
  // a legacy-rail fact (another loan) arms the LAR clock only
  await h.run("projectEvent", { op: "record_fact", loan_id: "L-2", liquidation_type: "fcl_fnma_acquired", legal_date: "2026-10-14", processed_at: new Date(processed).toISOString(), purchaser: "fnma", insured_flag: "mi", mode: "legacy" });
  assert.equal(h.timers.byCode("FNMA_LL202605_FORECLOSURE_EVENT_NEXTBD").length, 1); assert.equal(h.timers.byCode("FNMA_IRM_LIQ_AC70_72_NEXTBD_2000").length, 2);
  // acceptance is written from the parsed fnma-p360 response only; the inbound record is validated before the event is appended
  const ack = { op: "accept_p360", fact_id: fact.fact_id, fnma_loan_number: "1234567890", liquidation_event_type: "Third-Party Sale", p360_case_id: "P360-TPS-77", accepted_at: new Date(at("2026-10-15", "18:30")).toISOString(), action_code: "71", env: "api-clve" };
  await assert.rejects(h.run("projectEvent", { ...ack, fnma_response_parsed: true }), RangeError);   // an acceptance dated after `now` is not a response we hold yet
  h.clock.set(new Date(at("2026-10-15", "19:00")).toISOString());
  await h.refused("projectEvent", ack, "NO_ACCEPT_WITHOUT_RESPONSE");
  await assert.rejects(h.run("projectEvent", { ...ack, fnma_response_parsed: true, fnma_loan_number: "12345" }), RangeError);
  await assert.rejects(h.run("projectEvent", { ...ack, fnma_response_parsed: true, liquidation_event_type: "Payoff" }), RangeError);
  assert.equal(p360.status, "armed");
  const accepted = await h.run("projectEvent", { ...ack, fnma_response_parsed: true });
  assert.equal(accepted.accepted, true); assert.equal(accepted.liquidation_event_type, "Third-Party Sale");
  const ev = h.events.all().find((e) => e.type === "p360.liquidation_event.accepted")!;
  assert.ok(eventMatches(parseEventPattern(REG.get("FNMA_LL202605_FORECLOSURE_EVENT_NEXTBD")!.satisfied)!, ev)); assert.equal(ev.loanId, "L-1");
  assert.equal(p360.status, "satisfied"); assert.equal(lar.status, "armed");   // the LAR 71 clock still waits for `investor_events.submitted`
});
test("5.3 code change after close (IRM 4-08): draftCpmNotice{op=detect} emits liquidation.code_change.needed arming SM_LIQ_CODE_CHANGE_CPM_2BD (2 BD from detection); the agent's send is refused and the fnma_portal_operator's send emits cpm.notification.sent, satisfying it", async () => {
  // Thu Nov 5, 2026 15:00 ET — the October removal closed Tue Nov 3 17:00 ET (BD2); a sale set aside now goes to SF CPM (71 → 70: submit a REOgram to CPM)
  const h = harness(new Date(at("2026-11-05", "15:00")).toISOString());
  const d = await h.run("draftCpmNotice", { op: "detect", from_code: "71", to_code: "70", accepted_period: "2026-10", reason: "foreclosure sale set aside by court order; Fannie Mae acquires" });
  assert.equal(d.path, "code_change_cpm"); assert.equal(d.after_close, true); assert.equal(d.cpm_action, "submit_reogram"); assert.equal(toIso(Date.parse(d.close_at as string)), toIso(at("2026-11-03", "17:00"))); assert.equal(d.cpm_due_on, "2026-11-09");
  const draft = d.draft as { status: string; send_by: string[]; body: string }; assert.equal(draft.status, "draft"); assert.deepEqual(draft.send_by, ["fnma_portal_operator", "officer"]); assert.match(draft.body, /from 71 to 70/);
  const ev = h.events.all().find((e) => e.type === "liquidation.code_change.needed")!;
  assert.ok(eventMatches(parseEventPattern(REG.get("SM_LIQ_CODE_CHANGE_CPM_2BD")!.trigger)!, ev));
  const cpm = h.timer("SM_LIQ_CODE_CHANGE_CPM_2BD")!; assert.equal(cpm.status, "armed"); assert.equal(cpm.anchorDate, "2026-11-05"); assert.equal(cpm.dueDate, "2026-11-09");
  // 70 → 71: CPM cancels the REOgram
  assert.equal((await h.run("draftCpmNotice", { op: "detect", loan_id: "L-3", from_code: "70", to_code: "71", accepted_period: "2026-10", reason: "third-party bid confirmed" })).cpm_action, "cancel_reogram");
  // the agent drafts; only fnma_portal_operator / officer send — and the send needs the CPM reference as evidence
  const send = { send: true, kind: "code_change", from_code: "71", to_code: "70", sent_via: "email", reference: "CPM-2026-11-05-001" };
  await h.refused("draftCpmNotice", send, "AGENT_DRAFTS_ONLY");
  await h.refused("draftCpmNotice", send, "AGENT_DRAFTS_ONLY", { kind: "human", id: "u-analyst", role: "ops_analyst" });
  await assert.rejects(h.run("draftCpmNotice", { ...send, reference: "" }, OPERATOR), RangeError);
  assert.equal(cpm.status, "armed");
  const sent = await h.run("draftCpmNotice", send, OPERATOR);
  assert.equal(sent.sent, true); assert.equal(sent.sent_by_role, "fnma_portal_operator"); assert.equal(sent.reference, "CPM-2026-11-05-001");
  const se = h.events.all().find((e) => e.type === "cpm.notification.sent")!; assert.ok(eventMatches(parseEventPattern(REG.get("SM_LIQ_CODE_CHANGE_CPM_2BD")!.satisfied)!, se));
  assert.equal(cpm.status, "satisfied");
  // the officer may send a readd request too; a detection before BD2 17:00 ET is a correcting event, not a CPM request (no clock)
  assert.equal((await h.run("draftCpmNotice", { ...send, kind: "readd", reference: "readd-1" }, OFFICER)).kind, "readd");
  const inside = harness(new Date(at("2026-11-03", "12:00")).toISOString());
  const c = await inside.run("draftCpmNotice", { op: "detect", from_code: "71", to_code: "70", accepted_period: "2026-10", reason: "sale set aside" });
  assert.equal(c.path, "correction_pending"); assert.equal(c.after_close, false); assert.equal(c.event_id, null); assert.equal(inside.timers.byCode("SM_LIQ_CODE_CHANGE_CPM_2BD").length, 0);
});
test("5.3 guardrails read the loan, not the call: AC 60 needs the loan's payoff.funds.cleared event; a re-projection of an accepted removal after BD2 17:00 ET is refused however the call is labelled, and the post-close path flags fnma_liquidated_in_error, opens the qc_finding and escalates to the officer", async () => {
  // AC 60: Fri Oct 16, 2026 — the caller's `funds_cleared: true` is not evidence
  const h = harness(new Date(at("2026-10-16", "09:00")).toISOString());
  const payoff = { kind: "payoff", insured: "none", legal_date: "2026-10-16", principal_cents: 19950000n, interest_cents: 148942n, fnma_loan_number: "1234567890", funds_cleared: true };
  await h.refused("projectEvent", payoff, "NO_AC60_WITHOUT_CLEARED_FUNDS");
  h.events.append({ type: "payoff.funds.cleared", loanId: "L-1", actor: SYSTEM, payload: { processed_at: new Date(at("2026-10-15", "14:00")).toISOString(), remittance_type: "aa", amount_cents: "20098942" } });
  const ac60 = await h.run("projectEvent", payoff);
  assert.equal((ac60.lar as { action_code: string }).action_code, "60"); assert.equal(ac60.event_type, "removal.payoff"); assert.equal(ac60.correction, false); assert.equal(ac60.activity_period, "2026-10");
  assert.equal(h.events.all().filter((e) => e.type === "investor_events.projected").length, 1);
  // Thu Nov 5, 2026 15:00 ET: the October removal (LAR 71) was accepted; every way of re-projecting it is a correction after close
  const late = harness(new Date(at("2026-11-05", "15:00")).toISOString());
  late.events.append({ type: "investor_events.accepted", loanId: "L-1", actor: SYSTEM, payload: { family: "removal", event_type: "removal.liquidation.third_party", action_code: "71", activity_period: "2026-10" } });
  const tps = { kind: "third_party_sale", insured: "none", legal_date: "2026-10-14", principal_cents: 24908861n, interest_cents: 124544n, fnma_loan_number: "1234567890" };
  await late.refused("projectEvent", { ...tps, correction: true, activity_period: "2026-10" }, "NO_REMOVAL_CORRECTION_AFTER_BD2");
  await late.refused("projectEvent", { ...tps, supersedes_event_id: "ie-1" }, "NO_REMOVAL_CORRECTION_AFTER_BD2");
  await late.refused("projectEvent", tps, "NO_REMOVAL_CORRECTION_AFTER_BD2");                       // the loan's accepted removal makes it a correction; nothing on the call says so
  assert.equal(late.events.all().filter((e) => e.type === "investor_events.projected").length, 0);
  // a late-notified liquidation on a loan with no accepted removal is a first report, not a correction (rule 3: current period, true legal date, reported_late)
  const first = await late.run("projectEvent", { ...tps, loan_id: "L-9" });
  assert.equal(first.correction, false); assert.equal((first.lar as { action_date: string }).action_date, "101426");
  const fact = await late.run("projectEvent", { op: "record_fact", loan_id: "L-9", liquidation_type: "fcl_third_party", legal_date: "2026-10-14", processed_at: late.clock.now(), purchaser: "third_party", insured_flag: "none" });
  assert.equal(fact.reported_late, true); assert.equal(fact.activity_period, "2026-11"); assert.equal(fact.legal_date, "2026-10-14");
  // rule 6 / T6 on the bus: the post-close payoff error
  const err = await late.run("projectEvent", { op: "post_close_error", accepted_period: "2026-10", reported_principal_cents: 24908861n, reported_interest_cents: 124544n, reason: "wire reversed Nov 4" });
  assert.equal(err.after_close, true); assert.equal(err.fnma_liquidated_in_error, true); assert.equal(err.amount_due_cents, 25033405n); assert.equal(err.case, "qc_finding"); assert.equal(err.owner, "partner_non_fnma");
  const esc = late.escalations.opened.find((e) => e.id === err.escalation_id)!; assert.equal(esc.kind, "officer"); assert.equal(esc.caseId, err.case_id);
  const flagged = late.events.all().find((e) => e.type === "loans.fnma_liquidated_in_error")!; assert.equal(flagged.payload.amount_due_cents, "25033405"); assert.equal(flagged.payload.readd_request_to, "readd_requests@fanniemae.com");
  const opened = late.events.all().find((e) => e.type === "case.opened")!; assert.equal(opened.payload.kind, "qc_finding"); assert.equal(opened.payload.case_id, err.case_id);
  // inside the window nothing is flagged and no case opens (the correcting event is projected instead)
  const inside = await harness(new Date(at("2026-11-03", "16:00")).toISOString()).run("projectEvent", { op: "post_close_error", accepted_period: "2026-10", reported_principal_cents: 24908861n, reported_interest_cents: 124544n });
  assert.equal(inside.correction_projected, true); assert.equal(inside.case_id, null); assert.equal(inside.escalation_id, null);
});
