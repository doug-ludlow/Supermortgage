// 5.6 Repurchase reporting
// spec/sections/05-investor-reporting-remittance-fannie-mae/5-6-repurchase-reporting.md
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
import { TOOLS_5_6 } from "../../app/tools/section5-6.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { mbsRepurchasePrice, portfolioAaRepurchasePrice, appealLadder, dpoIndemnification } from "./repurchase.ts";
import { crsAaRequest } from "./remittance.ts";
import { projectLar96 } from "./lar.ts";
import { applyInvestorTimerOverrides } from "./timers.ts";
import { applySatisfiedOverrides_5_6 } from "./timers-5-6.ts";
import { ET, projectLar65, mbsExpressUnscheduledDraft, perDiemInterest } from "./ops.ts";
import { recordSubmissionAck } from "./ops-5-1.ts";
import { processRepurchase, ingestFileReviewSelection, submitReviewDocuments, documentsDueOn, stageDeadline, repurchaseProceedsDue, updateRepurchaseOwnership, type Emitter } from "./ops-5-6.ts";

const at = (d: string, hhmm: string) => zonedEpochMs(D(d), hhmm, ET);
const iso = (d: string, hhmm: string) => toIso(at(d, hhmm));
/** The registry as src/domain/timer-overrides.ts composes it for 5.6: the §5 section overrides, then the process overrides (which win). */
const REG = (() => { const r = loadRegistry(); applyInvestorTimerOverrides(r); applySatisfiedOverrides_5_6(r); return r; })();
const ESCALATES_TO = loadAgentsFile().processes.find((p) => p.process === "5.6")!.escalates_to;
const AGENT: Actor = { kind: "agent", id: "investor-reporting" };
const OFFICER: Actor = { kind: "human", id: "u-officer", role: "officer" };
/** The 5.6 tools on the bus over a real timer engine (5.6 rows only), the entity store and the escalation service. */
function harness(nowIso: string) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock); const ledger = new MemoryLedger();
  const timers = new TimerEngine(REG, events, { processes: ["5.6"] });
  const decisions: DecisionInput[] = [];
  const ctx: UowContext = { loanId: "L-1", events, ledger, timers, clock, decide: (d) => { decisions.push(d); } };
  const store = new EntityStore(); const escalations = new EscalationService(events, clock);
  const rt: ToolRuntime = { store, ports: {}, escalations, services: {} };
  const agents = new AgentRegistry(); const cmds = new Map(TOOLS_5_6.map((d) => { const cmd = toolCommand(d, rt, ESCALATES_TO); agents.registerTool(d.agent, cmd.name); return [d.name, cmd] as const; })); const bus = new CommandBus(agents);
  const run = async (name: string, input: Record<string, unknown>, actor: Actor = AGENT): Promise<Record<string, unknown>> => (await bus.execute(cmds.get(name)!, actor, input, ctx)).output as Record<string, unknown>;
  const timer = (code: string) => { const all = timers.byCode(code); assert.ok(all.length, `${code} armed`); return all[all.length - 1]!; };
  const emitter = (actor: Actor = AGENT): Emitter => ({ events, actor, now: clock.now() });
  const doc = (id: string) => { store.put("documents", id, { id, kind: "repurchase_approval" }, OFFICER, clock.now()); return id; };
  return { clock, events, timers, store, escalations, decisions, run, timer, emitter, doc, ofType: (t: string) => events.ofType(t) };
}
const LOAN = { loan_id: "L-1", repurchase_id: "RP-1" };

test("5.6-T1: Given a Fannie Mae demand received Sept 15, 2026, then pay-by and first-appeal deadlines are Nov 14, 2026; second appeal 15 days after a denial received Dec 1 → Dec 16; the case shows the ladder.", async () => {
  assert.deepEqual(appealLadder(D("2026-09-15"), D("2026-12-01")), { pay_by: "2026-11-14", first_appeal_by: "2026-11-14", second_appeal_by: "2026-12-16" });
  assert.equal(appealLadder(D("2026-09-15")).second_appeal_by, null);
  // the demand letter is ingested into the qc_finding case two days after receipt: the clocks anchor on receipt (edge case: original dates), not on ingestion
  const h = harness(iso("2026-09-17", "10:00"));
  const d = await h.run("recordDecision", { ...LOAN, decision_kind: "demand_received", received_on: "2026-09-15", demand_kind: "repurchase", amount_cents: 20398192n, demand_document_id: "doc-demand" });
  assert.equal(d.decision_kind, "demand_received"); assert.equal(h.decisions.length, 1); assert.equal(h.decisions[0]!.action, "repurchase.demand_received");
  assert.equal(h.ofType("repurchase.demand.received")[0]!.payload.case_type, "qc_finding");
  assert.equal(h.timer("FNMA_A1302_REPURCHASE_PAY_60").dueDate, "2026-11-14"); assert.equal(h.timer("FNMA_A1302_APPEAL1_60").dueDate, "2026-11-14"); assert.equal(h.timer("FNMA_A1302_APPEAL1_60").anchorDate, "2026-09-15");
  // the agent may prepare the appeal package but never files it; the officer's decision satisfies the first-appeal clock
  await assert.rejects(h.run("recordDecision", { ...LOAN, decision_kind: "appeal_decided", stage: 1, outcome: "filed", decision_document_id: "doc-appeal-1", decided_on: "2026-11-10" }), (e: unknown) => e instanceof CommandRefused && e.code === "NEVER_COMMITS_PARTNER");
  h.clock.set(iso("2026-11-10", "15:00"));
  await h.run("recordDecision", { ...LOAN, decision_kind: "appeal_decided", stage: 1, outcome: "filed", decision_document_id: "doc-appeal-1", decided_on: "2026-11-10" }, OFFICER);
  assert.equal(h.timer("FNMA_A1302_APPEAL1_60").status, "satisfied"); assert.equal(h.timer("FNMA_A1302_REPURCHASE_PAY_60").status, "armed", "paying is not appealing");
  // Fannie Mae's denial received Dec 1 → second appeal by Dec 16; the officer waives it on Dec 10 → satisfied
  h.clock.set(iso("2026-12-01", "16:00"));
  const den = await h.run("recordDecision", { ...LOAN, decision_kind: "appeal_denied", stage: 1, received_on: "2026-12-01", denial_document_id: "doc-denial-1" });
  assert.ok(den.event_id); assert.equal(h.timer("FNMA_A1302_APPEAL2_15").dueDate, "2026-12-16");
  h.clock.set(iso("2026-12-10", "11:00"));
  await h.run("recordDecision", { ...LOAN, decision_kind: "appeal_decided", stage: 2, outcome: "filed", decision_document_id: "doc-appeal-2", decided_on: "2026-12-10" }, OFFICER);
  assert.equal(h.timer("FNMA_A1302_APPEAL2_15").status, "satisfied");
  // second denial Dec 20 → impasse (30 days → Jan 19, 2027); the officer's escalation letter on Jan 10 satisfies it and enters management escalation (30 → Feb 9)
  h.clock.set(iso("2026-12-20", "12:00"));
  await h.run("recordDecision", { ...LOAN, decision_kind: "appeal_denied", stage: 2, received_on: "2026-12-20", denial_document_id: "doc-denial-2" });
  assert.equal(h.ofType("repurchase.stage.entered")[0]!.payload.stage, "impasse"); assert.equal(stageDeadline("impasse", D("2026-12-20")), "2027-01-19");
  assert.equal(h.timer("FNMA_A1302_IMPASSE_30").dueDate, "2027-01-19"); assert.equal(h.timer("FNMA_A1302_IMPASSE_30").status, "armed");
  h.clock.set(iso("2027-01-10", "12:00"));
  await h.run("recordDecision", { ...LOAN, decision_kind: "stage_action_recorded", stage: "impasse", action_taken: "management escalation letter sent", recorded_on: "2027-01-10", document_id: "doc-escalation", next_stage: "escalation" }, OFFICER);
  const impasse = h.timers.byCode("FNMA_A1302_IMPASSE_30");
  assert.deepEqual(impasse.map((t) => [t.status, t.dueDate]), [["satisfied", "2027-01-19"], ["armed", "2027-02-09"]]);
  assert.deepEqual([stageDeadline("escalation", D("2027-01-10")), stageDeadline("idr_retainer", D("2027-01-10")), stageDeadline("next_stage", D("2027-01-10"))], ["2027-02-09", "2027-01-25", "2027-01-25"]);
  // the case shows the ladder: every rung is an event on the repurchase aggregate, in order
  assert.deepEqual(h.events.all().filter((e) => e.aggregate?.kind === "repurchase" && e.aggregate.id === "RP-1").map((e) => e.type),
    ["repurchase.demand.received", "repurchase.appeal.decided", "repurchase.appeal.denied", "repurchase.appeal.decided", "repurchase.appeal.denied", "repurchase.stage.entered", "repurchase.stage.action_recorded", "repurchase.stage.entered"]);
  assert.equal(h.decisions.length, 6, "one decision row per case action");
});
test("5.6-T2: Given an MBS S/S loan with scheduled UPB $199,500 and PTR 6%, then the price is $200,497.50 and LAR 65 reports principal $199,500.00 / interest $997.50.", () => {
  const p = mbsRepurchasePrice(19950000n, "6.000");
  assert.deepEqual(p, { principal_cents: 19950000n, interest_cents: 99750n, price_cents: 20049750n, action_code: "65" });
  const lar = projectLar96("123456789", "4000000001", { lpi_date: D("2026-10-01"), upb_cents: 0n, nib_cents: 0n, interest_cents: p.interest_cents, principal_cents: p.principal_cents, other_fees_cents: 0n, action_code: p.action_code, action_date: D("2026-10-16") });
  assert.deepEqual([lar.fields.action_code, lar.fields.principal, lar.fields.interest], ["65", "0001995000{", "0000009975{"]);
});
test("5.6-T3: Given a portfolio A/A loan (purchase price 101.5%, LPI Sept 1, repurchase Oct 16), then principal $202,492.50 and interest $1,489.42 are reported and the CRS 001 batch is prepared the same day.", async () => {
  const p = portfolioAaRepurchasePrice(19950000n, "101.500", "6.000", D("2026-09-01"), D("2026-10-16"));
  assert.deepEqual([p.principal_cents, p.interest_cents, p.price_cents], [20249250n, 148942n, 20398192n]);
  assert.equal(perDiemInterest(19950000n, "6.000"), 3279n);                          // $32.7945 per day, rounded; the calculator accrues the 15 days exactly (÷365)
  const crs = crsAaRequest(p.price_cents, D("2026-10-16"), false);
  assert.equal(crs.instruct, true); assert.equal(crs.code, "001"); assert.equal(crs.settlement_date, "2026-10-19");
  // through the tools: the projection prices the loan the same way, and the accepted LAR 65 schedules the CRS 001 request the same day (16:00 ET)
  const h = harness(iso("2026-10-16", "10:00")); h.doc("doc-approval-1");
  const r = await h.run("projectEvent", { ...LOAN, approval_document_id: "doc-approval-1", processed_at: iso("2026-10-16", "09:30"), effective_date: "2026-10-16", remittance_type: "A/A", actual_upb_cents: 19950000n, purchase_price_pct: "101.500", ptr: "6.000", lpi_date: "2026-09-01" });
  assert.deepEqual((r.price as { principal_cents: bigint; interest_cents: bigint; price_cents: bigint }), p);
  assert.deepEqual(await h.run("buildCrsBatch", { type: "AA", amount_cents: p.price_cents }), { crs_code: "001", drafted_by_type: false, amount_cents: 20398192n, funding_source: "responsible_party" });
  const s = await h.run("buildCrsBatch", { ...LOAN, op: "schedule", accepted_event_id: "ie-1", accepted_on: "2026-10-16", activity_period: "2026-10", remittance_type: "A/A", amount_cents: p.price_cents });
  assert.deepEqual([s.cycle, s.remittance_due_on, s.crs_code, s.instruct_by_at], ["aa_crs_001", "2026-10-16", "001", iso("2026-10-16", "16:00")]);
  assert.equal(h.timer("FNMA_F120_REPURCHASE_PROCEEDS_BY_TYPE").dueDate, "2026-10-16");
  // ≤ $2,500 rides the month-end sweep instead (F-1-20 / 5.2 rule 2)
  assert.deepEqual(repurchaseProceedsDue({ remittance_type: "AA", mbs_express: false, activity_period: "2026-10", accepted_on: D("2026-10-16"), amount_cents: 200_000n }).remittance_due_on, "2026-10-30");
  assert.deepEqual([repurchaseProceedsDue({ remittance_type: "AA", mbs_express: false, activity_period: "2026-10", accepted_on: D("2026-10-16"), amount_cents: 1n, kind: "make_whole" }).crs_code, repurchaseProceedsDue({ remittance_type: "SS", mbs_express: false, activity_period: "2026-10", accepted_on: D("2026-11-02"), amount_cents: 1n, kind: "reo" }).crs_code], ["309", "315"]);
});
test("5.6-T4: Given the repurchase processed Mon Nov 2, 2026 (BD1), then LAR 65 is due Tue Nov 3 17:00 ET.", async () => {
  const r = projectLar65({ approval_document_id: "doc-approval-1", processed_at_ms: zonedEpochMs(D("2026-11-02"), "15:10", ET), arm_modification_feature: false });
  assert.equal(r.blocked, false); assert.equal(r.event!.action_code, "65"); assert.equal(toIso(r.event!.due_ms), toIso(zonedEpochMs(D("2026-11-03"), "17:00", ET)));
  // through the bus: `repurchase.processed` arms the removal clock on the processed timestamp and the projection carries the BD2 17:00 ET due
  const h = harness(iso("2026-11-02", "15:30")); h.doc("doc-approval-1");
  await assert.rejects(h.run("projectEvent", { ...LOAN, approval_document_id: "doc-nowhere", processed_at: iso("2026-11-02", "15:10"), effective_date: "2026-11-02", remittance_type: "S/S" }), (e: unknown) => e instanceof RangeError && /not a document on file/.test(e.message));
  const out = await h.run("projectEvent", { ...LOAN, approval_document_id: "doc-approval-1", processed_at: iso("2026-11-02", "15:10"), effective_date: "2026-11-02", remittance_type: "S/S", scheduled_upb_cents: 19950000n, ptr: "6.000" });
  const ev = out.event as { action_code: string; processed_at: string; due_at: string };
  assert.deepEqual([out.blocked, ev.action_code, ev.processed_at, ev.due_at], [false, "65", iso("2026-11-02", "15:10"), iso("2026-11-03", "17:00")]);
  const t = h.timer("FNMA_IRM_REPURCHASE_AC65_NEXTBD_2000");
  assert.equal(t.anchorDate, "2026-11-02"); assert.equal(t.dueDate, "2026-11-03");
  assert.equal(toIso(t.dueAt!), iso("2026-11-03", "20:00")); // registry offset: next fannie_et BD 20:00 ET; the 17:00 BD2 tightening rides on the projection's due_at (period-close checklist (iii))
  // the LAR 65 goes out on the 5.1 adapter path: its acknowledgement satisfies the clock
  h.clock.set(iso("2026-11-03", "09:00"));
  recordSubmissionAck(h.events, { submission_id: "S-1", channel: "lsdu_b2b", format: "lar80", acked_at_ms: at("2026-11-03", "09:00"), records: [{ event_id: "ie-1", loan_id: "L-1", fnma_loan_number: "4000000001", event_type: "removal.repurchase", family: "removal", sequence: 1 }] });
  assert.equal(t.status, "satisfied"); assert.equal(toIso(Date.parse(t.satisfiedAt!)), iso("2026-11-03", "09:00"));
  // rule 5 / IRM 4-08: after BD2 17:00 ET of the following month the November removal cannot be re-projected — refused without any `correction`/`family` label from the caller
  h.clock.set(iso("2026-12-02", "17:01")); // December BD2 = Wed Dec 2
  await assert.rejects(h.run("projectEvent", { ...LOAN, approval_document_id: "doc-approval-1", processed_at: iso("2026-11-02", "15:10"), effective_date: "2026-11-02", remittance_type: "S/S" }), (e: unknown) => e instanceof CommandRefused && e.code === "NO_REMOVAL_CORRECTION_AFTER_BD2");
  h.clock.set(iso("2026-12-02", "16:59"));
  assert.equal((await h.run("projectEvent", { ...LOAN, approval_document_id: "doc-approval-1", processed_at: iso("2026-11-02", "15:10"), effective_date: "2026-11-02", remittance_type: "S/S" })).replayed, true, "before the close a correction replays the processed row, never a second one");
  assert.equal(h.ofType("repurchase.processed").length, 1);
});
test("5.6-T5: Given an approval document is missing, then the LAR 65 projection is blocked and an `officer` escalation exists; once attached, the event is created with the original processed timestamp.", async () => {
  const processed = zonedEpochMs(D("2026-11-02"), "15:10", ET);
  const blocked = projectLar65({ approval_document_id: null, processed_at_ms: processed, arm_modification_feature: false });
  assert.equal(blocked.blocked, true); assert.equal(blocked.escalation, "officer"); assert.equal(blocked.event, null);
  const attached = projectLar65({ approval_document_id: "doc-approval-1", processed_at_ms: processed, arm_modification_feature: true });
  assert.equal(attached.blocked, false); assert.equal(attached.event!.processed_at_ms, processed); assert.equal(attached.event!.action_code, "67");
  // on the bus the guardrail refuses before anything runs; the ops path records the processed fact once and the block with its officer escalation
  const h = harness(iso("2026-11-02", "15:30"));
  await assert.rejects(h.run("projectEvent", { ...LOAN, processed_at: toIso(processed), effective_date: "2026-11-02", remittance_type: "S/S" }), (e: unknown) => e instanceof CommandRefused && e.code === "LAR65_NEEDS_APPROVAL_DOC");
  const first = processRepurchase(h.emitter(), { ...LOAN, processed_at_ms: processed, approval_document_id: null, arm_modification_feature: true, effective_date: D("2026-11-02"), remittance_type: "SS" });
  assert.deepEqual([first.blocked, first.escalation, first.projected, first.replayed], [true, "officer", null, false]);
  assert.equal(h.ofType("repurchase.lar.blocked")[0]!.payload.escalation, "officer");
  const clock = h.timer("FNMA_IRM_REPURCHASE_AC65_NEXTBD_2000"); assert.equal(clock.anchorDate, "2026-11-02");
  // the approval arrives the next morning: the event is created with the original processed timestamp and the clock never moved
  h.clock.set(iso("2026-11-03", "08:00")); h.doc("doc-approval-1");
  const out = await h.run("projectEvent", { ...LOAN, approval_document_id: "doc-approval-1", processed_at: toIso(processed), effective_date: "2026-11-02", remittance_type: "S/S", arm_modification_feature: true });
  const ev = out.event as { action_code: string; processed_at: string; due_at: string };
  assert.deepEqual([out.blocked, out.replayed, ev.action_code, ev.processed_at, ev.due_at], [false, true, "67", toIso(processed), iso("2026-11-03", "17:00")]);
  assert.equal(h.ofType("repurchase.processed").length, 1); assert.equal(h.timers.byCode("FNMA_IRM_REPURCHASE_AC65_NEXTBD_2000").length, 1);
  assert.equal(h.ofType("investor_events.projected")[0]!.payload.processed_at, toIso(processed));
});
test("5.6-T6: Given a DPO insurer paying 60% and a denied $30,000 claim, then indemnification = $18,000; a later 70% payout adds $3,000.", () => {
  assert.equal(dpoIndemnification(3000000n, "60"), 1800000n); assert.equal(dpoIndemnification(3000000n, "70", 1800000n), 300000n);
});
test("5.6-T7: Given an MBS Express pool repurchase reported in October, then unscheduled principal is funded for the BD4 November draft (Thu Nov 5, 2026).", async () => {
  assert.equal(mbsExpressUnscheduledDraft(D("2026-10-15")), "2026-11-05");
  const { events, timers } = (() => { const clock = new FixedClock("2026-10-15T14:00:00.000Z"); const events = new MemoryEventStore(clock); return { events, timers: new TimerEngine(REG, events) }; })();
  events.append({ type: "repurchase.processed", loanId: "L-1", actor: SYSTEM, payload: { processed_at: "2026-10-15T14:00:00.000Z" } });
  assert.equal(toIso(timers.byCode("FNMA_IRM_REPURCHASE_AC65_NEXTBD_2000")[0]!.dueAt!), toIso(at("2026-10-16", "20:00")));
  // the accepted LAR 65 (October period) schedules the proceeds on the MBS Express unscheduled-principal draft: BD4 November = Thu Nov 5 (Nov 2 BD1)
  const h = harness(iso("2026-11-02", "11:00"));
  await h.run("recordDecision", { ...LOAN, decision_kind: "demand_received", received_on: "2026-09-15", demand_kind: "repurchase", amount_cents: 20049750n, demand_document_id: "doc-demand" });
  const s = await h.run("buildCrsBatch", { ...LOAN, op: "schedule", accepted_event_id: "ie-1", accepted_on: "2026-11-02", activity_period: "2026-10", remittance_type: "S/S", mbs_express: true, amount_cents: 20049750n });
  assert.deepEqual([s.cycle, s.remittance_due_on, s.crs_code, s.drafted], ["mbs_express_bd4", "2026-11-05", null, true]);
  assert.deepEqual([repurchaseProceedsDue({ remittance_type: "SS", mbs_express: false, activity_period: "2026-10", accepted_on: D("2026-11-02"), amount_cents: 1n }).remittance_due_on, repurchaseProceedsDue({ remittance_type: "SA", mbs_express: false, activity_period: "2026-10", accepted_on: D("2026-11-02"), amount_cents: 1n }).remittance_due_on], ["2026-11-18", "2026-11-20"]);
  const proceeds = h.timer("FNMA_F120_REPURCHASE_PROCEEDS_BY_TYPE"); assert.equal(proceeds.dueDate, "2026-11-05"); assert.equal(proceeds.anchorDate, "2026-11-05");
  // Nov 5: the draft settles from the responsible party's funds and is matched — `funded` satisfies the proceeds clock and the 60-day pay-by; the match starts the 10-BD ownership update
  h.clock.set(iso("2026-11-05", "12:00"));
  await assert.rejects(h.run("buildCrsBatch", { ...LOAN, op: "match", remittance_id: "R-1", expected_cents: 20049750n, received_cents: 20049700n, matched_on: "2026-11-05", remittance_type: "S/S", cycle: "mbs_express_bd4", bank_reference: "ACH-1" }), (e: unknown) => e instanceof RangeError && /do not match/.test(e.message));
  const m = await h.run("buildCrsBatch", { ...LOAN, op: "match", remittance_id: "R-1", expected_cents: 20049750n, received_cents: 20049750n, matched_on: "2026-11-05", remittance_type: "S/S", cycle: "mbs_express_bd4", bank_reference: "ACH-1" });
  assert.equal(m.status, "funded"); assert.deepEqual((m.ledger as { account: string; side: string; amount_cents: bigint }[]).map((l) => [l.account, l.side, l.amount_cents]), [["fnma_remittance_payable", "Dr", 20049750n], ["corporate_cash", "Cr", 20049750n]]);
  assert.equal(h.ofType("remittances.funded")[0]!.payload.kind, "repurchase");
  assert.equal(proceeds.status, "satisfied"); assert.equal(h.timer("FNMA_A1302_REPURCHASE_PAY_60").status, "satisfied");
  const own = h.timer("SM_REPURCHASE_OWNERSHIP_UPDATE_10BD"); assert.equal(own.anchorDate, "2026-11-05"); assert.equal(own.dueDate, "2026-11-20"); // 10 servicer BDs: Veterans Day (Nov 11) skipped
  await assert.rejects(h.run("recordDecision", { ...LOAN, decision_kind: "ownership_updated", mers_confirmation_id: "MERS-TOB-1", investor: "partner", updated_on: "2026-11-12" }), (e: unknown) => e instanceof RangeError && /custodian_release_id/.test(e.message));
  h.clock.set(iso("2026-11-12", "12:00"));
  await h.run("recordDecision", { ...LOAN, decision_kind: "ownership_updated", mers_confirmation_id: "MERS-TOB-1", custodian_release_id: "F2009-1", investor: "partner", updated_on: "2026-11-12" });
  assert.equal(own.status, "satisfied"); assert.equal(h.ofType("repurchase.ownership.updated")[0]!.payload.status, "closed");
});

test("5.6 FNMA_A1302_DOCS_30: file selected for review Sept 15, 2026 → documents due Oct 15; the submission satisfies it; an empty submission is refused", async () => {
  assert.equal(documentsDueOn(D("2026-09-15")), "2026-10-15");
  const h = harness(iso("2026-09-15", "14:00"));
  await h.run("recordDecision", { ...LOAN, decision_kind: "file_review_selected", selected_on: "2026-09-15", notification_document_id: "doc-selection" });
  const t = h.timer("FNMA_A1302_DOCS_30"); assert.equal(t.dueDate, "2026-10-15"); assert.equal(t.status, "armed");
  await assert.rejects(h.run("recordDecision", { ...LOAN, decision_kind: "documents_submitted", document_ids: [] }), (e: unknown) => e instanceof RangeError && /document_ids/.test(e.message));
  await assert.rejects(h.run("recordDecision", { ...LOAN, decision_kind: "documents_submitted", document_ids: ["doc-x"] }), (e: unknown) => e instanceof RangeError && /not on file/.test(e.message));
  h.doc("doc-file-1"); h.doc("doc-file-2"); h.clock.set(iso("2026-10-01", "14:00"));
  await h.run("recordDecision", { ...LOAN, decision_kind: "documents_submitted", document_ids: ["doc-file-1", "doc-file-2"] });
  assert.equal(t.status, "satisfied"); assert.equal(toIso(Date.parse(t.satisfiedAt!)), iso("2026-10-01", "14:00"));
  // the ingestion path outside the bus (letter parsed into the case) emits the same facts
  const e2 = harness(iso("2026-09-15", "14:00"));
  const sel = ingestFileReviewSelection(e2.emitter(), { ...LOAN, selected_on: D("2026-09-15"), notification_document_id: "doc-selection" }); assert.equal(sel.documents_due_on, "2026-10-15");
  const sub = submitReviewDocuments(e2.emitter(), { ...LOAN, document_ids: ["doc-file-1"] });
  assert.ok(eventMatches(REG.get("FNMA_A1302_DOCS_30")!.triggerPattern!, sel.event)); assert.ok(eventMatches(REG.get("FNMA_A1302_DOCS_30")!.satisfiedPattern!, sub));
});
test("5.6 every registry row is armed by an event ops-5-6 emits and satisfied by one it (or the 5.1 adapter) emits", () => {
  const h = harness(iso("2026-11-02", "11:00")); const em = h.emitter(OFFICER);
  const processed = processRepurchase(em, { ...LOAN, processed_at_ms: at("2026-11-02", "10:00"), approval_document_id: "doc-approval-1", arm_modification_feature: false, effective_date: D("2026-11-02"), remittance_type: "SS" });
  const { submitted } = recordSubmissionAck(h.events, { submission_id: "S-1", channel: "lsdu_b2b", format: "lar80", acked_at_ms: at("2026-11-02", "12:00"), records: [{ event_id: "ie-1", loan_id: "L-1", fnma_loan_number: "4000000001", event_type: "removal.repurchase", family: "removal", sequence: 1 }] });
  const ownership = updateRepurchaseOwnership(em, { ...LOAN, mers_confirmation_id: "M-1", custodian_release_id: "C-1", investor: "partner", updated_on: D("2026-11-12") });
  const pairs: [string, string, string][] = [
    ["FNMA_A1302_DOCS_30", "repurchase.file_review.selected", "repurchase.documents.submitted"], ["FNMA_A1302_REPURCHASE_PAY_60", "repurchase.demand.received", "remittances.funded"],
    ["FNMA_A1302_APPEAL1_60", "repurchase.demand.received", "repurchase.appeal.decided"], ["FNMA_A1302_APPEAL2_15", "repurchase.appeal.denied", "repurchase.appeal.decided"],
    ["FNMA_A1302_IMPASSE_30", "repurchase.stage.entered", "repurchase.stage.action_recorded"], ["FNMA_IRM_REPURCHASE_AC65_NEXTBD_2000", "repurchase.processed", "investor_events.submitted"],
    ["FNMA_F120_REPURCHASE_PROCEEDS_BY_TYPE", "repurchase.proceeds.scheduled", "remittances.funded"], ["SM_REPURCHASE_OWNERSHIP_UPDATE_10BD", "repurchase.proceeds.matched", "repurchase.ownership.updated"]];
  for (const [code, trig, sat] of pairs) { const d = REG.get(code)!; assert.equal(d.triggerPattern!.type, trig, code); assert.equal(d.satisfiedPattern!.type, sat, code); }
  assert.ok(eventMatches(REG.get("FNMA_IRM_REPURCHASE_AC65_NEXTBD_2000")!.triggerPattern!, processed.processed));
  assert.ok(eventMatches(REG.get("FNMA_IRM_REPURCHASE_AC65_NEXTBD_2000")!.satisfiedPattern!, submitted[0]!));
  assert.ok(eventMatches(REG.get("SM_REPURCHASE_OWNERSHIP_UPDATE_10BD")!.satisfiedPattern!, ownership));
  assert.equal(REG.get("FNMA_A1302_IMPASSE_30")!.anchorField, "stage_deadline_on"); assert.equal(REG.get("FNMA_F120_REPURCHASE_PROCEEDS_BY_TYPE")!.anchorField, "remittance_due_on");
});
