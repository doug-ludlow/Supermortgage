// 5.1 Loan Activity Report (LAR) submission
// spec/sections/05-investor-reporting-remittance-fannie-mae/5-1-loan-activity-report-lar-submission.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { zonedEpochMs, toIso } from "../../kernel/calendar/zoned.ts";
import { MemoryEventStore, FixedClock, SYSTEM, eventMatches, type Actor } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine, loadRegistry } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry, loadAgentsFile } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, toolCommand, type ToolRuntime, type ToolDef } from "../../app/tools.ts";
import { SECTION_05_TOOLS } from "../../app/tools/section05.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { FakeFnmaLsdu, FakeFnmaServicingEvents } from "../../infra/integrations/fnma.ts";
import { fannieBusinessDay, larDeadlineMs, lar83DeadlineMs, iredSweepDate, iredSweepRunMs, iredDeadlineMs, bd2CloseMs, periodAnchors } from "./period.ts";
import { scheduledMonth } from "./remittance.ts";
import { projectLar96, projectLar97, parseLar96, validateLar80, zoned, unzoned, idempotencyKey, LAR96_POSITIONS } from "./lar.ts";
import { SequenceAllocator, buildLarBatch, applyBatch, type BatchEvent, type InvestorEventRow } from "./batch.ts";
import { ET, triageHardReject, headOfLine, postCloseRemovalError, escrowDepositRouting, bulkAckWatch, workException, LAR_DECISION_FIELDS, softRejectInterest, closeSoftRejectAtPeriodClose, periodCloseChecklist } from "./ops.ts";
import { createInvestorEvent, submitLarFile, recordSubmissionAck, ingestLarFeedback, ingestServicingEventResponses, recordTriage, closeSoftRejectsAtPeriodClose, openReportingPeriod, iredSweepRun, bulkCutoffSweep, closeReportingPeriod, completeEscrowAttestation, monthEnd, compFeeLadder, compensatoryFeeWatch, ingestSmduDeferralAcceptance, channelMode, type TrackedEvent } from "./ops-5-1.ts";

const SN = "123456789", FL = "4000000001", FL2 = "4000000002";
const at = (d: string, hhmm: string) => zonedEpochMs(D(d), hhmm, ET);
/** The registry as the services load it (section + process overrides): the patterns every emitted event is checked against. */
const REG = loadOverriddenRegistry();
const sat = (code: string) => REG.get(code)!.satisfiedPattern!;
/** A fully overridden registry on a fresh in-memory event store: the real engine arms and satisfies the timers under test. */
function engine(startIso: string) {
  const clock = new FixedClock(startIso); const events = new MemoryEventStore(clock);
  return { clock, events, timers: new TimerEngine(loadOverriddenRegistry(), events) };
}
const P = { lpi_date: D("2026-10-01"), upb_cents: 24_977_400n, nib_cents: 0n, interest_cents: 125_000n, principal_cents: 22_600n, other_fees_cents: 0n, action_code: "00", action_date: D("2026-10-13") };
const AGENT: Actor = { kind: "agent", id: "investor-reporting" };
const OPERATOR: Actor = { kind: "human", id: "u-portal", role: "fnma_portal_operator" };
const trackedOf = (c: { event_id: string; family: TrackedEvent["family"]; activity_period: string; per_loan_sequence: number }, loan_id: string, fnma: string, event_type: TrackedEvent["event_type"], extra: Partial<TrackedEvent> = {}): TrackedEvent =>
  ({ event_id: c.event_id, loan_id, fnma_loan_number: fnma, event_type, family: c.family, activity_period: c.activity_period, sequence: c.per_loan_sequence, ...extra });
/** The bus harness (src/app/tools.test.ts): a unit of work with no engine arming, the §5 tools bound for the investor-reporting agent. */
function uow(loanId: string, nowIso: string): UowContext & { decisions: DecisionInput[]; fixed: FixedClock } {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock); const decisions: DecisionInput[] = [];
  return { loanId, events, ledger: new MemoryLedger(), timers: new TimerEngine(loadRegistry(), events, { processes: [] }), clock, decide: (d) => { decisions.push({ loanId, ...d }); }, decisions, fixed: clock };
}
const runtime = (ctx: UowContext): ToolRuntime => ({ store: new EntityStore(), escalations: new EscalationService(ctx.events, ctx.clock), services: {}, ports: { lsdu: new FakeFnmaLsdu() } });
/** src/app/tools/index.ts bindTools for the §5 tools alone (the all-sections index is not loaded here). */
function bindSection5(rt: ToolRuntime, agents: AgentRegistry, defs: readonly ToolDef[] = SECTION_05_TOOLS) {
  const escalates = new Map(loadAgentsFile().processes.map((p) => [p.process, p.escalates_to] as const));
  return new Map(defs.map((d) => { const cmd = toolCommand(d, rt, escalates.get(d.process) ?? []); agents.registerTool(d.agent, cmd.name); return [`${d.process} ${d.name}`, cmd] as const; }));
}

test("5.1-T1: Given an S/S loan ($250,000, 6.5%, PTR 6.0%) with a contractual payment processed Tue 2026-10-13 15:10 ET, when the event is created, then a LAR 96 with interest `0000125000{`, principal `0000022600{`, UPB `0024977400{`, action `00` is submitted before Wed 2026-10-14 20:00 ET and timer `FNMA_C4301_LAR_NONREMOVAL_NEXTBD_2000` is satisfied.", async () => {
  const m = scheduledMonth(25_000_000n, "6.500", "6.000", 158_017n);
  const payload = { ...P, interest_cents: m.fnma_interest_cents, principal_cents: m.fnma_principal_cents, upb_cents: m.ending_scheduled_upb_cents };
  const lar = projectLar96(SN, FL, payload);
  // IRM zone-signed S9(9)V99: $1,250.00 → `0000012500{`, $226.00 → `0000002260{`, $249,774.00 → `0002497740{`. The spec's T1 strings carry one extra zero (a transcription slip — 5.1-T8 and the IRM examples follow the width-11 rule; docs/audit/AUDIT-REPORT.md).
  assert.equal(lar.fields.interest, "0000012500{"); assert.equal(lar.fields.principal, "0000002260{"); assert.equal(lar.fields.upb, "0002497740{"); assert.equal(lar.fields.action_code, "00");
  assert.equal(unzoned(lar.fields.interest), 125_000n); assert.equal(unzoned(lar.fields.principal), 22_600n); assert.equal(unzoned(lar.fields.upb), 24_977_400n);
  // rule 1: the canonical row is created from the §2 payment event, sequence 1, October period, due next fannie_et BD 20:00 ET
  const processed = at("2026-10-13", "15:10");
  const { clock, events, timers } = engine(toIso(processed));
  const seq = new SequenceAllocator();
  const input = { loan_id: "L-1", servicer_number: SN, fnma_loan_number: FL, event_type: "payment.contractual" as const, effective_date: D("2026-10-13"), processed_at_ms: processed, payload, mode: "legacy" as const, open_periods: ["2026-10"], source_loan_event_id: "pay-1" };
  const created = createInvestorEvent(events, seq, input);
  assert.deepEqual([created.family, created.activity_period, created.per_loan_sequence, created.replayed], ["payment", "2026-10", 1, false]);
  assert.equal(toIso(created.due_at_ms!), toIso(at("2026-10-14", "20:00"))); assert.equal(toIso(larDeadlineMs(processed, false)), toIso(at("2026-10-14", "20:00")));
  assert.equal(createInvestorEvent(events, seq, input).replayed, true, "a replay of the same source event returns the existing row");
  assert.equal(events.all().filter((e) => e.type === "investor_events.created").length, 1);
  // the engine: `investor_events.created{family=payment}` arms FNMA_C4301… for Wed 20:00 ET (and not the removal clock)
  const inst = timers.byCode("FNMA_C4301_LAR_NONREMOVAL_NEXTBD_2000")[0]!;
  assert.equal(inst.status, "armed"); assert.equal(toIso(inst.dueAt!), toIso(at("2026-10-14", "20:00"))); assert.equal(timers.byCode("FNMA_IRM_REMOVAL_NEXTBD_2000").length, 0);
  // the fnma-lsdu adapter at 09:30 the next morning: the file goes to LSDU and its acknowledgement is the `submitted` fact the clock is satisfied by
  clock.set(toIso(at("2026-10-14", "09:30")));
  const lsdu = new FakeFnmaLsdu();
  const { submission, submitted } = await submitLarFile(events, lsdu, { channel: "lsdu_b2b", now_ms: at("2026-10-14", "09:30"), records: [{ ...trackedOf(created, "L-1", FL, "payment.contractual"), record: lar.record }] });
  assert.equal(submission.records, 1); assert.equal(lsdu.submissions.get(submission.submissionId)!.records[0]!.record, lar.record.replace(/\r$/, ""), "LSDU received the 80-character record exactly as projected");
  assert.equal(submitted[0]!.type, "investor_events.submitted"); assert.equal(submitted[0]!.payload.family, "payment"); assert.ok(Date.parse(submitted[0]!.occurredAt) < inst.dueAt!, "submitted before Wed 20:00 ET");
  assert.ok(eventMatches(sat("FNMA_C4301_LAR_NONREMOVAL_NEXTBD_2000"), submitted[0]!));
  assert.equal(inst.status, "satisfied"); assert.equal(inst.satisfiedByEventId, submitted[0]!.id);
  assert.ok(timers.evaluate(toIso(at("2026-10-14", "20:01"))).every((b) => b.def.code !== "FNMA_C4301_LAR_NONREMOVAL_NEXTBD_2000"));
});
test("5.1-T2: Given a loan with no payment by CD22 (Thu 2026-10-22), when the 18:00 ET sweep runs, then `payment.none` is submitted before 20:00 ET; if Nov 22 (Sunday), then the sweep runs Fri 2026-11-20.", async () => {
  assert.equal(iredSweepDate(D("2026-10-01")), "2026-10-22"); assert.equal(iredSweepDate(D("2026-11-01")), "2026-11-20");
  assert.equal(toIso(iredSweepRunMs(D("2026-10-01"))), toIso(at("2026-10-22", "18:00"))); assert.equal(toIso(iredDeadlineMs(D("2026-11-01"))), toIso(at("2026-11-20", "20:00")));
  // the period opens once per servicer number and enrols every active loan: the per-loan IRED floor (CD22 20:00 ET) and the LL-2026-05 no-payment clock (23:59 ET) arm on the enrolment
  const { clock, events, timers } = engine("2026-10-01T09:00:00.000Z");
  const oct = openReportingPeriod(events, { month_of: D("2026-10-01"), servicer_number: SN, loans: [{ loan_id: "L-1", fnma_loan_number: FL, reporting: "summary" }, { loan_id: "L-2", fnma_loan_number: FL2, reporting: "summary" }] });
  assert.equal(oct.enrolled.length, 2); assert.equal(oct.opened.aggregate?.id, `${SN}:2026-10`);
  const ired = timers.byCode("FNMA_IRM_LAR_IRED_CD22_2000"), none = timers.byCode("FNMA_LL202605_NOPAYMENT_CD22");
  assert.deepEqual(ired.map((x) => [x.loanId, toIso(x.dueAt!)]), [["L-1", toIso(at("2026-10-22", "20:00"))], ["L-2", toIso(at("2026-10-22", "20:00"))]]);
  assert.deepEqual(none.map((x) => [x.loanId, toIso(x.dueAt!)]), [["L-1", toIso(at("2026-10-22", "23:59"))], ["L-2", toIso(at("2026-10-22", "23:59"))]]);
  assert.equal(timers.byCode("FNMA_IRM_PERIOD_CLOSE_BD2_1700").length, 1, "the period clocks arm once, on the period, not per loan");
  // November: the 22nd is a Sunday → the sweep and both floors fall on Fri 2026-11-20
  const nov = engine("2026-11-01T09:00:00.000Z");
  openReportingPeriod(nov.events, { month_of: D("2026-11-01"), servicer_number: SN, loans: [{ loan_id: "L-1", fnma_loan_number: FL, reporting: "summary" }] });
  assert.equal(toIso(nov.timers.byCode("FNMA_IRM_LAR_IRED_CD22_2000")[0]!.dueAt!), toIso(at("2026-11-20", "20:00"))); assert.equal(toIso(nov.timers.byCode("FNMA_LL202605_NOPAYMENT_CD22")[0]!.dueAt!), toIso(at("2026-11-20", "23:59")));
  // the 18:00 ET sweep on Thu Oct 22 (never earlier): L-2 has an accepted payment, L-1 has none → one payment.none row (LAR 96, unchanged LPI/UPB, zero interest/principal, action 00)
  const seq = new SequenceAllocator({ "L-1": 3 });
  const loans = [{ loan_id: "L-1", fnma_loan_number: FL, reporting: "summary" as const, accepted_payment_event: false, position: { lpi_date: D("2026-09-01"), upb_cents: 25_000_000n, nib_cents: 0n } }, { loan_id: "L-2", fnma_loan_number: FL2, reporting: "summary" as const, accepted_payment_event: true, position: { lpi_date: D("2026-10-01"), upb_cents: 10_000_000n, nib_cents: 0n } }];
  assert.throws(() => iredSweepRun(events, seq, { month_of: D("2026-10-01"), servicer_number: SN, now_ms: at("2026-10-22", "17:59"), loans }), RangeError);
  clock.set(toIso(at("2026-10-22", "18:00")));
  const run = iredSweepRun(events, seq, { month_of: D("2026-10-01"), servicer_number: SN, now_ms: at("2026-10-22", "18:00"), loans });
  assert.deepEqual(run.sweep.project_none_for, ["L-1"]); assert.equal(run.projections.length, 1);
  const p = run.projections[0]!; assert.deepEqual([p.created.family, p.created.per_loan_sequence, p.projection.event_type], ["nonpayment", 3, "payment.none"]);
  assert.deepEqual([p.lar!.fields.lpi, p.lar!.fields.upb, p.lar!.fields.interest, p.lar!.fields.principal, p.lar!.fields.action_code], ["0926", "0002500000{", "0000000000{", "0000000000{", "00"]);
  assert.ok(run.sweep.run_ms < p.projection.submit_by_ms); assert.equal(toIso(p.projection.submit_by_ms), toIso(at("2026-10-22", "20:00")));
  // submitted through the adapter at 18:20 — before 20:00 ET
  const lsdu = new FakeFnmaLsdu();
  const { submission, submitted } = await submitLarFile(events, lsdu, { channel: "lsdu_b2b", now_ms: at("2026-10-22", "18:20"), records: [{ ...trackedOf(p.created, "L-1", FL, "payment.none"), record: p.lar!.record }] });
  assert.ok(Date.parse(submitted[0]!.occurredAt) < at("2026-10-22", "20:00"));
  assert.ok(!eventMatches(sat("FNMA_IRM_LAR_IRED_CD22_2000"), submitted[0]!), "a submitted-but-not-accepted LAR does not clear the IRED floor");
  // LSDU's parsed acknowledgement (accepted) is the fact both CD22 floors are satisfied by. The feedback is ingested in its own unit of work with the
  // loan's open no-payment instance hydrated (TimerEngine.restore, the persisted-instance path). The IRED row is `recurring`, and TimerEngine.onEvent
  // re-arms a recurring instance inside its own satisfaction loop, so the same accepted event would re-satisfy it without end (src/kernel/timers/engine.ts
  // defect, reported in the notes): that row's "Satisfied by" clause is proven on the registry pattern against the very event the ingestion emits.
  const work = new MemoryEventStore(clock); const workTimers = new TimerEngine(loadOverriddenRegistry(), work);
  const noneL1 = none.find((x) => x.loanId === "L-1")!; workTimers.restore([noneL1]);
  const fb = ingestLarFeedback(work, { submission_id: submission.submissionId, feedback: await lsdu.feedback(submission.submissionId), events: [trackedOf(p.created, "L-1", FL, "payment.none")], received_at_ms: at("2026-10-22", "18:45") });
  assert.deepEqual(fb.accepted, [p.created.event_id]);
  const accepted = fb.events[0]!;
  assert.equal(accepted.type, "investor_events.accepted"); assert.deepEqual([accepted.payload.event_type, accepted.payload.family, accepted.payload.source], ["payment.none", "nonpayment", "lsdu"]);
  assert.ok(eventMatches(sat("FNMA_IRM_LAR_IRED_CD22_2000"), accepted), "the accepted payment.none (family nonpayment) is what the IRED floor is satisfied by");
  assert.ok(eventMatches(sat("FNMA_LL202605_NOPAYMENT_CD22"), accepted));
  assert.equal(noneL1.status, "satisfied"); assert.equal(noneL1.satisfiedByEventId, accepted.id);
  assert.equal(none.find((x) => x.loanId === "L-2")!.status, "armed", "the floors are per loan");
});
test("5.1-T3: Given a payoff processed Mon 2026-11-02 (BD1), then the action-code-60 LAR is due Tue 2026-11-03 **17:00** ET (BD2); processed Fri 2026-10-30 → due Mon 2026-11-02 20:00 ET.", () => {
  assert.equal(fannieBusinessDay(D("2026-11-02"), 1), "2026-11-02");
  assert.equal(toIso(larDeadlineMs(at("2026-11-02", "10:00"), true)), toIso(at("2026-11-03", "17:00")));
  assert.equal(toIso(larDeadlineMs(at("2026-10-30", "10:00"), true)), toIso(at("2026-11-02", "20:00")));
  // the canonical removal rows carry the domain clock as `due_at`: BD1 processing → BD2 17:00 ET; Friday processing → Monday 20:00 ET
  const store = new MemoryEventStore(new FixedClock("2026-10-30T14:00:00.000Z")); const seq = new SequenceAllocator();
  const payoff = { ...P, action_code: "60", action_date: D("2026-11-02"), interest_cents: 124_544n, principal_cents: 24_908_861n, upb_cents: 0n };
  const bd1 = createInvestorEvent(store, seq, { loan_id: "L-1", servicer_number: SN, fnma_loan_number: FL, event_type: "removal.payoff", effective_date: D("2026-11-02"), processed_at_ms: at("2026-11-02", "10:00"), payload: payoff, mode: "legacy", open_periods: ["2026-10", "2026-11"] });
  assert.equal(bd1.family, "removal"); assert.equal(toIso(bd1.due_at_ms!), toIso(at("2026-11-03", "17:00")));
  assert.equal(bd1.activity_period, "2026-10", "a removal processed by BD2 reports in the earliest open period (rule 2)");
  const fri = createInvestorEvent(store, seq, { loan_id: "L-2", servicer_number: SN, fnma_loan_number: FL2, event_type: "removal.payoff", effective_date: D("2026-10-30"), processed_at_ms: at("2026-10-30", "10:00"), payload: { ...payoff, action_date: D("2026-10-30") }, mode: "legacy", open_periods: ["2026-10"] });
  assert.equal(toIso(fri.due_at_ms!), toIso(at("2026-11-02", "20:00")));
  // the BD2 17:00 ET tightening is the period close itself: a removal processed on BD1 and not submitted by 17:00 fails checklist item (iii)
  const base = { period: "2026-10", active_loans: 10, loans_with_accepted_event_or_none: 10, open_hard_or_invalid_rejects: 0, trial_balance_diff_loans: 0, soft_rejects_without_triage: 0, cash_position_variance_cents: 0n, delinquency_file_accepted: true, escrow_attestation_prepared: "not_required" as const };
  const late = periodCloseChecklist({ ...base, removals: [{ event_id: "rm-1", processed_at_ms: at("2026-11-02", "10:00"), submitted_at_ms: at("2026-11-03", "18:30") }] });
  assert.equal(toIso(late.close_ms), toIso(at("2026-11-03", "17:00"))); assert.equal(late.items.find((x) => x.id === "iii")!.ok, false); assert.equal(late.complete, false); assert.equal(late.escalation, "officer");
  const onTime = periodCloseChecklist({ ...base, removals: [{ event_id: "rm-1", processed_at_ms: at("2026-11-02", "10:00"), submitted_at_ms: at("2026-11-03", "15:30") }, { event_id: "rm-2", processed_at_ms: at("2026-10-30", "10:00"), submitted_at_ms: at("2026-11-02", "19:00") }] });
  assert.equal(onTime.complete, true); assert.equal(onTime.status, "closed");
  // the engine's removal clock (grammar: next fannie_et BD 20:00 ET) for the Friday case, satisfied by the adapter's acknowledgement of the AC 60 record
  const { events, timers } = engine(toIso(at("2026-10-30", "10:00")));
  const created = createInvestorEvent(events, new SequenceAllocator(), { loan_id: "L-1", servicer_number: SN, fnma_loan_number: FL, event_type: "removal.payoff", effective_date: D("2026-10-30"), processed_at_ms: at("2026-10-30", "10:00"), payload: { ...payoff, action_date: D("2026-10-30") }, mode: "legacy", open_periods: ["2026-10"] });
  const inst = timers.byCode("FNMA_IRM_REMOVAL_NEXTBD_2000")[0]!;
  assert.equal(toIso(inst.dueAt!), toIso(at("2026-11-02", "20:00")));
  assert.equal(timers.byCode("FNMA_C4301_LAR_NONREMOVAL_NEXTBD_2000").length, 0, "a removal does not arm the non-removal clock");
  const { submitted } = recordSubmissionAck(events, { submission_id: "S-60", channel: "lsdu_b2b", format: "lar80", records: [trackedOf(created, "L-1", FL, "removal.payoff")], acked_at_ms: at("2026-11-02", "09:15") });
  assert.equal(submitted[0]!.payload.family, "removal"); assert.ok(eventMatches(sat("FNMA_IRM_REMOVAL_NEXTBD_2000"), submitted[0]!)); assert.equal(inst.status, "satisfied");
});
test(`5.1-T4: Given a hard reject "LPI mismatch" received 2026-10-14 09:40 ET, when triage finds a ledger posting error, then a Section 2 correction, a superseding event with a new sequence and the same period are accepted before BD1 of the next month; head-of-line blocking prevents later events for that loan from being sent first.`, () => {
  const received = at("2026-10-14", "09:40");
  const t = triageHardReject({ received_at_ms: received, root_cause: "ledger_error", confidence: 0.95, event: { id: "ev-1", sequence: 7, activity_period: "2026-10" } });
  assert.equal(t.route, "section2_correction"); assert.equal(t.correction_command, "cashiering.correction.post");
  assert.deepEqual(t.superseding_event, { sequence: 8, supersedes_event_id: "ev-1", activity_period: "2026-10" });
  assert.equal(toIso(t.triage_due_ms), toIso(at("2026-10-14", "13:40")));
  assert.equal(fannieBusinessDay(D("2026-11-01"), 1), "2026-11-02");
  assert.equal(toIso(t.resubmit_by_ms), toIso(at("2026-11-02", "20:00")));            // BD1 20:00 ET of the next month
  // LSDU's extract at 09:40: a hard reject on ev-1 (sequence 7, October) — the exception arms the 4-hour triage SLA and the BD1 correction clock
  const { clock, events, timers } = engine(toIso(received));
  const ev1: TrackedEvent = { event_id: "ev-1", loan_id: "L", fnma_loan_number: FL, event_type: "payment.contractual", family: "payment", activity_period: "2026-10", sequence: 7 };
  const fb = ingestLarFeedback(events, { submission_id: "S-7", feedback: [{ eventId: "ev-1", fnmaLoanNumber: FL, kind: "hard", code: "LPI_MISMATCH", message: "LPI mismatch" }], events: [ev1], received_at_ms: received });
  assert.deepEqual(fb.exceptions, [{ event_id: "ev-1", severity: "hard", code: "LPI_MISMATCH" }]);
  const exc = fb.events[0]!; assert.equal(exc.type, "investor_event_exceptions.detected"); assert.deepEqual([exc.payload.family, exc.payload.period_end, exc.payload.status], ["payment", "2026-10-31", "rejected_hard"]);
  const triage = timers.byCode("FNMA_IRM_REJECT_TRIAGE_4H")[0]!, correction = timers.byCode("FNMA_IRM_NONREMOVAL_CORRECTION_BD1_2000")[0]!;
  assert.equal(toIso(triage.dueAt!), toIso(at("2026-10-14", "13:40"))); assert.equal(toIso(correction.dueAt!), toIso(at("2026-11-02", "20:00")));
  assert.equal(timers.byCode("FNMA_IRM_REMOVAL_CORRECTION_BD2_1700").length, 0, "a payment exception never arms the removal correction clock");
  assert.throws(() => ingestLarFeedback(events, { submission_id: "S-7", feedback: [{ eventId: "ev-1", fnmaLoanNumber: "4000000009", kind: "hard", code: "X" }], events: [ev1], received_at_ms: received }), RangeError, "feedback naming another loan is never applied");
  // triage at 10:05 — a ledger posting error at 0.95 confidence: the Section 2 correction command; the decision record satisfies the SLA
  clock.set(toIso(at("2026-10-14", "10:05")));
  const tri = recordTriage(events, { event_id: "ev-1", loan_id: "L", exception_code: "LPI_MISMATCH", root_cause: "ledger_error", evidence: ["doc-ledger-1"], action: t.correction_command, deadline_at: toIso(t.resubmit_by_ms), confidence: 0.95, rule_set_version: "irm-2026-09", model_version: "m-1", actor: { kind: "agent", id: "investor-reporting" }, agent_enabled: true, triaged_at_ms: at("2026-10-14", "10:05") });
  assert.equal(tri.held, false); assert.equal(tri.record.action, "cashiering.correction.post"); assert.deepEqual(Object.keys(tri.record), [...LAR_DECISION_FIELDS]);
  assert.ok(eventMatches(sat("FNMA_IRM_REJECT_TRIAGE_4H"), tri.event)); assert.equal(triage.status, "satisfied");
  const held = recordTriage(new MemoryEventStore(clock), { event_id: "ev-9", loan_id: "L", exception_code: "UPB_MISMATCH", root_cause: "unknown", evidence: [], action: "resubmit", deadline_at: toIso(t.resubmit_by_ms), confidence: 0.6, rule_set_version: "irm-2026-09", actor: { kind: "agent", id: "investor-reporting" }, agent_enabled: true, triaged_at_ms: at("2026-10-14", "10:06") });
  assert.equal(held.held, true); assert.equal(held.record.action, "hold_and_escalate"); assert.equal(held.escalation!.kind, "human_agent");   // guardrail: confidence < 0.8 → hold and escalate
  // the superseding event: a new sequence (8), the same October period, `supersedes_event_id`
  const corr = createInvestorEvent(events, new SequenceAllocator({ L: 8 }), { loan_id: "L", servicer_number: SN, fnma_loan_number: FL, event_type: "payment.contractual", effective_date: D("2026-10-13"), processed_at_ms: at("2026-10-14", "10:30"), payload: P, mode: "legacy", open_periods: ["2026-10"], supersedes_event_id: "ev-1" });
  assert.deepEqual([corr.per_loan_sequence, corr.activity_period, corr.event.payload.supersedes_event_id], [8, "2026-10", "ev-1"]);
  // head-of-line: while ev-1 is an open hard reject, its superseding event goes first and later events for the loan wait; other loans are unaffected
  const open = headOfLine([{ id: "ev-1", loan_id: "L", sequence: 7, status: "rejected_hard" }, { id: corr.event_id, loan_id: "L", sequence: 8, status: "projected", supersedes_event_id: "ev-1" }, { id: "ev-3", loan_id: "L", sequence: 9, status: "queued" }, { id: "ev-9", loan_id: "M", sequence: 1, status: "queued" }]);
  assert.deepEqual(open.sendable.map((e) => e.id), [corr.event_id, "ev-9"]); assert.deepEqual(open.blocked.map((e) => e.id), ["ev-3"]);
  // the correction is submitted and accepted on Oct 14 — before BD1 (Mon 2026-11-02 20:00 ET): ev-1 is superseded and the correction clock is satisfied
  recordSubmissionAck(events, { submission_id: "S-8", channel: "lsdu_b2b", format: "lar80", records: [trackedOf(corr, "L", FL, "payment.contractual")], acked_at_ms: at("2026-10-14", "11:00") });
  const acc = ingestLarFeedback(events, { submission_id: "S-8", feedback: [{ eventId: corr.event_id, fnmaLoanNumber: FL, kind: "accepted" }], events: [trackedOf(corr, "L", FL, "payment.contractual", { supersedes_event_id: "ev-1" })], received_at_ms: at("2026-10-14", "11:30") });
  assert.deepEqual([acc.accepted, acc.superseded], [[corr.event_id], ["ev-1"]]);
  const resolved = acc.events.find((e) => e.type === "investor_events.resolved")!;
  assert.deepEqual([resolved.payload.event_id, resolved.payload.status, resolved.payload.superseded_by], ["ev-1", "superseded", corr.event_id]);
  assert.ok(eventMatches(sat("FNMA_IRM_NONREMOVAL_CORRECTION_BD1_2000"), resolved)); assert.equal(correction.status, "satisfied"); assert.ok(Date.parse(resolved.occurredAt) < correction.dueAt!);
  // once the correcting event is accepted (ev-1 superseded) the block lifts; a waived reject does not block either
  const cleared = headOfLine([{ id: "ev-1", loan_id: "L", sequence: 7, status: "superseded" }, { id: corr.event_id, loan_id: "L", sequence: 8, status: "accepted" }, { id: "ev-3", loan_id: "L", sequence: 9, status: "queued" }]);
  assert.deepEqual(cleared.sendable.map((e) => e.id), ["ev-3"]); assert.deepEqual(cleared.blocked, []);
  assert.deepEqual(headOfLine([{ id: "ev-1", loan_id: "L", sequence: 7, status: "invalid", waived_reason: "readd pending; officer waiver" }, { id: "ev-3", loan_id: "L", sequence: 9, status: "queued" }]).blocked, []);
});
test("5.1-T5: Given a payoff LAR accepted in October 2026 and the error discovered 2026-11-05, then no correction is projected, a `qc_finding` case opens, and the remit/advance amount is computed.", async () => {
  const r = postCloseRemovalError({ accepted_period: "2026-10", discovered_at_ms: at("2026-11-05", "10:00"), reported_principal_cents: 24908861n, reported_interest_cents: 124544n });
  assert.equal(toIso(r.close_ms), toIso(at("2026-11-03", "17:00")));                  // BD2 17:00 ET closed the October period
  assert.equal(r.after_close, true); assert.equal(r.correction_projected, false); assert.equal(r.case, "qc_finding");
  assert.equal(r.fnma_liquidated_in_error, true); assert.equal(r.amount_due_cents, 24908861n + 124544n); assert.equal(r.escalation, "officer");
  // the projectEvent tool on the bus refuses the correction on Nov 5 15:00 ET: the family is read off the event type and the correction off the loan's accepted October payoff — no caller label decides it
  const ctx = uow("L-1", toIso(at("2026-11-05", "15:00")));
  ctx.events.append({ type: "investor_events.accepted", loanId: "L-1", actor: SYSTEM, payload: { event_id: "ie-oct-60", event_type: "removal.payoff", family: "removal", activity_period: "2026-10", status: "accepted" } });
  const agents = new AgentRegistry(); const cmds = bindSection5(runtime(ctx), agents); const bus = new CommandBus(agents);
  const cmd = cmds.get("5.1 projectEvent")!;
  const payoff = { ...P, action_code: "60", action_date: D("2026-10-20") };
  const refused = (e: unknown) => e instanceof CommandRefused && e.code === "NO_REMOVAL_CORRECTION_AFTER_BD2";
  await assert.rejects(bus.execute(cmd, AGENT, { event_type: "removal.payoff", payload: payoff, servicer_number: SN, fnma_loan_number: FL }, ctx), refused);
  await assert.rejects(bus.execute(cmd, AGENT, { event_type: "removal.payoff", payload: payoff, supersedes_event_id: "ie-oct-60", activity_period: "2026-10", servicer_number: SN, fnma_loan_number: FL }, ctx), refused);
  assert.deepEqual(ctx.events.all().filter((e) => e.type.startsWith("investor_events.")).map((e) => e.type), ["investor_events.accepted"], "nothing is created or projected after the close");
  // the same correction on Tue 2026-11-03 16:00 ET — before the 17:00 close — is created (new sequence, October period) and projected
  ctx.fixed.set(toIso(at("2026-11-03", "16:00")));
  const ok = await bus.execute(cmd, AGENT, { event_type: "removal.payoff", payload: payoff, supersedes_event_id: "ie-oct-60", activity_period: "2026-10", servicer_number: SN, fnma_loan_number: FL }, ctx);
  assert.equal((ok.output as { fields: { action_code: string }; activity_period: string }).fields.action_code, "60"); assert.equal((ok.output as { activity_period: string }).activity_period, "2026-10");
  const created = ctx.events.all().find((e) => e.type === "investor_events.created")!;
  assert.deepEqual([created.payload.family, created.payload.supersedes_event_id, created.payload.activity_period, created.payload.per_loan_sequence], ["removal", "ie-oct-60", "2026-10", 1]);
});
test("5.1-T6: Given `investor_reporting.escrow.deposit.mode=dual`, when an escrow deposit posts, then JSON goes to `api-clve` and no LAR is created (escrow has no LAR); when `mode=event` on 2026-12-01, the JSON goes to production and must be submitted by 03:00 ET next BD.", async () => {
  const dual = escrowDepositRouting("dual", at("2026-10-20", "10:00"));
  assert.equal(dual.json_env, "api-clve"); assert.equal(dual.lar, null); assert.equal(dual.submit_by_ms, null);
  const ev = escrowDepositRouting("event", at("2026-12-01", "10:00"));
  assert.equal(ev.json_env, "production"); assert.equal(ev.lar, null);
  assert.equal(toIso(ev.submit_by_ms!), toIso(at("2026-12-02", "03:00")));
  // the feature flags: escrow.* dual from 2026-10-01 (CIT), event from 2026-12-01; payment.* stays legacy
  assert.deepEqual([channelMode("escrow.deposit", D("2026-09-30")), channelMode("escrow.deposit", D("2026-10-20")), channelMode("escrow.deposit", D("2026-12-01")), channelMode("payment.contractual", D("2027-06-01"))], ["legacy", "dual", "event", "legacy"]);
  // dual: the canonical row exists (rule 1) with no production deadline — neither the LAR clock nor the 03:00 ET clock arms
  const { events, timers } = engine(toIso(at("2026-10-20", "10:00")));
  const escrowP = { ...P, action_date: D("2026-10-20"), interest_cents: 0n, principal_cents: 0n };
  const dualRow = createInvestorEvent(events, new SequenceAllocator(), { loan_id: "L-1", servicer_number: SN, fnma_loan_number: FL, event_type: "escrow.deposit", effective_date: D("2026-10-20"), processed_at_ms: at("2026-10-20", "10:00"), payload: escrowP, mode: "dual", open_periods: ["2026-10"] });
  assert.equal(dualRow.family, "escrow"); assert.equal(dualRow.due_at_ms, null);
  assert.equal(timers.byCode("FNMA_C4301_LAR_NONREMOVAL_NEXTBD_2000").length, 0, "escrow has no LAR: the LAR clock never arms"); assert.equal(timers.byCode("FNMA_LL202605_EVENT_NEXTBD_0300").length, 0);
  // event (2026-12-01): the 03:00 ET next-BD clock arms through the engine; the Servicing Platform's acknowledgement and response close it
  const evRow = createInvestorEvent(events, new SequenceAllocator({ "L-1": 2 }), { loan_id: "L-1", servicer_number: SN, fnma_loan_number: FL, event_type: "escrow.deposit", effective_date: D("2026-12-01"), processed_at_ms: at("2026-12-01", "10:00"), payload: { ...escrowP, action_date: D("2026-12-01") }, mode: "event", open_periods: ["2026-11", "2026-12"] });
  assert.equal(toIso(evRow.due_at_ms!), toIso(at("2026-12-02", "03:00")));
  const inst = timers.byCode("FNMA_LL202605_EVENT_NEXTBD_0300")[0]!; assert.equal(toIso(inst.dueAt!), toIso(at("2026-12-02", "03:00")));
  const se = new FakeFnmaServicingEvents();
  const submission = await se.submitEvents([{ eventId: evRow.event_id, fnmaLoanNumber: FL, eventType: "escrow.deposit", body: { "Loan Servicer Transaction Effective Date": "2026-12-01" } }], toIso(at("2026-12-01", "10:05")));
  const { submitted } = recordSubmissionAck(events, { submission_id: submission.submissionId, channel: "se_api", format: "se_json_v1", records: [trackedOf(evRow, "L-1", FL, "escrow.deposit")], acked_at_ms: at("2026-12-01", "10:05") });
  assert.ok(eventMatches(sat("FNMA_LL202605_EVENT_NEXTBD_0300"), submitted[0]!)); assert.equal(inst.status, "satisfied");
  const ing = ingestServicingEventResponses(events, { submission, events: [trackedOf(evRow, "L-1", FL, "escrow.deposit")], received_at_ms: at("2026-12-01", "10:06") });
  assert.deepEqual(ing.accepted, [evRow.event_id]); assert.deepEqual([ing.events[0]!.type, ing.events[0]!.payload.source, ing.events[0]!.payload.status], ["investor_events.accepted", "se", "accepted"]);
});
test("5.1-T7: Given a bulk file still unacknowledged at BD2 14:00 ET, then the adapter re-sends once and, failing an ack by 14:30, opens a `human_portal_task` with the file, due 15:00 ET.", () => {
  const bd2 = fannieBusinessDay(D("2026-11-01"), 2); assert.equal(bd2, "2026-11-03");
  const on = (hhmm: string) => zonedEpochMs(bd2, hhmm, ET);
  assert.equal(bulkAckWatch({ file_id: "F-1", acked: false, resent: false, now_ms: on("13:59"), bd2 }).action, "wait");
  assert.equal(bulkAckWatch({ file_id: "F-1", acked: false, resent: false, now_ms: on("14:00"), bd2 }).action, "resend");
  assert.equal(bulkAckWatch({ file_id: "F-1", acked: false, resent: true, now_ms: on("14:15"), bd2 }).action, "wait");
  const esc = bulkAckWatch({ file_id: "F-1", acked: false, resent: true, now_ms: on("14:30"), bd2 });
  assert.equal(esc.action, "portal_task"); assert.equal(esc.task!.kind, "human_portal_task"); assert.equal(esc.task!.file_id, "F-1");
  assert.equal(toIso(esc.task!.due_ms), toIso(on("15:00")));
  assert.equal(bulkAckWatch({ file_id: "F-1", acked: true, resent: true, now_ms: on("14:40"), bd2 }).action, "done");
  // the BD2 15:00 ET cutoff itself: the gate arms when the period opens; at 15:00 the adapter switches the bulk channel off and the still-unacknowledged file becomes an `lsdu_single` portal task due at the 17:00 close
  const { events, timers } = engine(toIso(on("12:00")));
  openReportingPeriod(events, { month_of: D("2026-10-01"), servicer_number: SN, loans: [], opened_at_ms: at("2026-10-01", "09:00") });
  const gate = timers.byCode("FNMA_IRM_BULK_CUTOFF_BD2_1500")[0]!; assert.equal(toIso(gate.dueAt!), toIso(on("15:00")));
  assert.equal(bulkCutoffSweep(events, { servicer_number: SN, period: "2026-10", now_ms: on("14:59"), unacked_files: [{ file_id: "F-1", record_count: 12 }] }).closed, false);
  const cut = bulkCutoffSweep(events, { servicer_number: SN, period: "2026-10", now_ms: on("15:00"), unacked_files: [{ file_id: "F-1", record_count: 12 }] });
  assert.equal(cut.closed, true); assert.deepEqual(cut.portal_tasks.map((t) => [t.kind, t.role, t.channel, t.file_id, toIso(t.due_ms)]), [["human_portal_task", "fnma_portal_operator", "lsdu_single", "F-1", toIso(on("17:00"))]]);
  assert.ok(eventMatches(sat("FNMA_IRM_BULK_CUTOFF_BD2_1500"), cut.event!)); assert.equal(gate.status, "satisfied");
});
test("5.1-T8: Given a LAR 96 amount −$9.91 principal, then encoding is `0000000099J`; $800.02 interest → `0000008000B`; record length is exactly 80 with CR.", async () => {
  assert.equal(zoned(-991n), "0000000099J"); assert.equal(zoned(80_002n), "0000008000B"); assert.equal(unzoned("0000000099J"), -991n); assert.equal(unzoned("0000008000B"), 80_002n);
  const lar = projectLar96("123456789", "4000000001", { ...P, principal_cents: -991n, interest_cents: 80_002n, other_fees_cents: -991n });
  assert.equal(lar.record.length, 81); assert.ok(lar.record.endsWith("\r")); assert.equal(lar.record.replace(/\r$/, "").length, 80);
  // the IRM positions, 1-based inclusive: 1–9 servicer · 10 F · 11–12 96 · 13 source 0 · 14–23 loan · 24–27 LPI MMYY · 28–38 UPB · 39–49 interest · 50–60 principal · 61–62 action · 63–68 MMDDYY · 69–76 other fees · 77–80 filler
  const r = lar.record; const at = ([a, b]: readonly [number, number]) => r.slice(a - 1, b);
  assert.equal(at(LAR96_POSITIONS.servicer_number), "123456789"); assert.equal(at(LAR96_POSITIONS.investor), "F"); assert.equal(at(LAR96_POSITIONS.record_type), "96"); assert.equal(at(LAR96_POSITIONS.source_code), "0");
  assert.equal(at(LAR96_POSITIONS.fnma_loan_number), "4000000001"); assert.equal(at(LAR96_POSITIONS.lpi), "1026"); assert.equal(at(LAR96_POSITIONS.upb), "0002497740{"); assert.equal(at(LAR96_POSITIONS.interest), "0000008000B");
  assert.equal(at(LAR96_POSITIONS.principal), "0000000099J"); assert.equal(at(LAR96_POSITIONS.action_code), "00"); assert.equal(at(LAR96_POSITIONS.action_date), "101326"); assert.equal(at(LAR96_POSITIONS.other_fees), "0000099J"); assert.equal(at(LAR96_POSITIONS.filler), "    ");
  // the codec validates its own output and round-trips it; a wrong investor byte or a bare digit in a zoned field is a contract-test failure
  assert.deepEqual(validateLar80(lar.record), []);
  const back = parseLar96(lar.record); assert.equal(back.principal_cents, -991n); assert.equal(back.interest_cents, 80_002n); assert.equal(back.upb_cents, 24_977_400n); assert.equal(back.other_fees_cents, -991n);
  assert.deepEqual(validateLar80(r.slice(0, 9) + "X" + r.slice(10)), ["pos 10 investor must be F"]);
  assert.deepEqual(validateLar80(r.slice(0, 48) + "0" + r.slice(49)), ["pos 39–49 interest is not zone-signed S9(9)V99"]);
  assert.ok(validateLar80(r.slice(0, 79)).includes("record is 79 characters, not 80"));
  // LAR 97 companion: pos 13 reversal flag, 24–34 gross payment, 35–42 MMDDYYYY, 73–80 full LPI
  const l97 = projectLar97("123456789", "4000000001", 158_017n, D("2026-10-13"), D("2026-10-01"), true);
  assert.equal(l97.length, 81); assert.equal(l97.slice(9, 13), "F971"); assert.equal(l97.slice(23, 34), "00000158017"); assert.equal(l97.slice(34, 42), "10132026"); assert.equal(l97.slice(72, 80), "10012026");
  assert.deepEqual(validateLar80(l97), []);
  // the adapter never ships a malformed record
  await assert.rejects(submitLarFile(new MemoryEventStore(new FixedClock("2026-10-14T13:00:00.000Z")), new FakeFnmaLsdu(), { channel: "lsdu_b2b", now_ms: Date.parse("2026-10-14T13:00:00.000Z"), records: [{ event_id: "ie-bad", loan_id: "L-1", fnma_loan_number: "4000000001", event_type: "payment.contractual", family: "payment", sequence: 1, record: r.slice(0, 79) }] }), RangeError);
});
test("5.1-T9: Given an ARM rate calculation date 2026-10-01 (look-back 45 days, effective 2026-11-15), then LAR 83 is due by the 5th `fannie_et` BD after 2026-10-01 = Thu 2026-10-08 20:00 ET.", () => {
  assert.equal(toIso(lar83DeadlineMs(D("2026-10-01"))), toIso(at("2026-10-08", "20:00")));
  const { events, timers } = engine("2026-10-01T13:00:00.000Z");
  events.append({ type: "loan_terms.rate_changed", loanId: "L-1", actor: SYSTEM, payload: { calculation_date: "2026-10-01", effective_date: "2026-11-15", look_back_days: 45 } });   // §2.4's event (the trigger is owned there)
  const inst = timers.byCode("FNMA_IRM_LAR83_5BD_2000")[0]!;
  assert.equal(inst.anchorDate, "2026-10-01"); assert.equal(toIso(inst.dueAt!), toIso(at("2026-10-08", "20:00")));
  // the LAR 83 row has its own 5-BD clock: creating it never arms the next-BD LAR clock; the adapter's acknowledgement of the `rate_payment.change` record satisfies it
  const row = createInvestorEvent(events, new SequenceAllocator({ "L-1": 4 }), { loan_id: "L-1", servicer_number: SN, fnma_loan_number: FL, event_type: "rate_payment.change", effective_date: D("2026-11-15"), processed_at_ms: at("2026-10-05", "10:00"), payload: { ...P, action_date: D("2026-10-05") }, mode: "legacy", open_periods: ["2026-10"] });
  assert.equal(row.family, "loan_data_change"); assert.equal(timers.byCode("FNMA_C4301_LAR_NONREMOVAL_NEXTBD_2000").length, 0);
  const { submitted } = recordSubmissionAck(events, { submission_id: "S-83", channel: "lsdu_b2b", format: "lar80", records: [trackedOf(row, "L-1", FL, "rate_payment.change")], acked_at_ms: at("2026-10-06", "09:00") });
  assert.ok(eventMatches(sat("FNMA_IRM_LAR83_5BD_2000"), submitted[0]!)); assert.equal(inst.status, "satisfied"); assert.ok(Date.parse(submitted[0]!.occurredAt) < inst.dueAt!);
});
test("5.1-T10: Given two events for the same loan processed in order (curtailment then contractual), then sequences 1 and 2 are assigned in that order and submitted in the same file in that order; a replay of the batch produces zero new rows (idempotency).", () => {
  const seq = new SequenceAllocator();
  const curtail = { ...P, action_date: D("2026-10-13"), interest_cents: 0n, principal_cents: 1_250_000n, upb_cents: 23_727_400n };
  // rule 1 through the canonical rows: processing order allocates 1 then 2, never reused
  const store = new MemoryEventStore(new FixedClock("2026-10-13T18:00:00.000Z"));
  const c1 = createInvestorEvent(store, seq, { loan_id: "L", servicer_number: SN, fnma_loan_number: FL, event_type: "payment.curtailment", effective_date: D("2026-10-13"), processed_at_ms: at("2026-10-13", "14:00"), payload: curtail, mode: "legacy", open_periods: ["2026-10"], source_loan_event_id: "curt-1" });
  const c2 = createInvestorEvent(store, seq, { loan_id: "L", servicer_number: SN, fnma_loan_number: FL, event_type: "payment.contractual", effective_date: D("2026-10-13"), processed_at_ms: at("2026-10-13", "14:01"), payload: P, mode: "legacy", open_periods: ["2026-10"], source_loan_event_id: "pay-1" });
  assert.deepEqual([c1.per_loan_sequence, c2.per_loan_sequence, seq.peek("L"), seq.allocate("M")], [1, 2, 3, 1]);
  assert.notEqual(c1.idempotency_key, c2.idempotency_key);
  const mk = (id: string, type: string, sequence: number, p: typeof P): BatchEvent => ({ id, loan_id: "L", sequence, status: "projected", idempotency_key: idempotencyKey(SN, FL, type, p.action_date, sequence, p), record: projectLar96(SN, FL, p).record });
  const evs = [mk(c2.event_id, "payment.contractual", c2.per_loan_sequence, P), mk(c1.event_id, "payment.curtailment", c1.per_loan_sequence, curtail)];
  assert.equal(evs[1]!.idempotency_key, c1.idempotency_key, "the batch carries the row's own key");
  const batch = buildLarBatch(evs);
  assert.deepEqual(batch.order, [c1.event_id, c2.event_id]); assert.equal(batch.record_count, 2); assert.deepEqual(batch.held, []);
  assert.equal(batch.file_content, evs[1]!.record + evs[0]!.record);
  // a duplicate projection (same key) never makes a second record; a replay of the whole batch inserts nothing
  assert.deepEqual(buildLarBatch([...evs, { ...mk("ev-1-dup", "payment.curtailment", c1.per_loan_sequence, curtail), id: "ev-1-dup" }]).duplicates_dropped, ["ev-1-dup"]);
  const rows = new Map<string, InvestorEventRow>();
  const first = applyBatch(rows, batch, evs); assert.equal(first.new_rows, 2); assert.equal(rows.size, 2);
  const replay = applyBatch(rows, buildLarBatch(evs), evs); assert.equal(replay.new_rows, 0); assert.equal(replay.replayed, 2); assert.equal(rows.size, 2);
  assert.equal(buildLarBatch(evs).file_sha256, batch.file_sha256);
});
test("5.1-T11: Given the agent is disabled, then the exception queue is worked by a human with identical decision-record fields and all timers still fire.", () => {
  const base = { event_id: "ev-1", exception_code: "LPI_MISMATCH", root_cause: "ledger_error" as const, evidence: ["doc-1"], action: "section2_correction", deadline_at: "2026-11-02T20:00:00-05:00", confidence: 1, rule_set_version: "irm-2026-09" };
  const human = workException({ agent_enabled: false, actor: { kind: "human", id: "ops-7" }, ...base });
  assert.deepEqual(Object.keys(human.record), [...LAR_DECISION_FIELDS]); assert.equal(human.worked_by, "human"); assert.equal(human.timers_fire, true);
  const agent = workException({ agent_enabled: true, actor: { kind: "agent", id: "investor-reporting" }, ...base, model_version: "m-1" });
  assert.deepEqual(Object.keys(agent.record), Object.keys(human.record));                                // identical decision-record fields
  assert.throws(() => workException({ agent_enabled: false, actor: { kind: "agent", id: "investor-reporting" }, ...base }), /worked by a human/);
  // the timers are the engine's, not the agent's: LSDU's hard reject and a new row arm the clocks; with nobody submitting they breach on schedule
  const detected = at("2026-10-14", "09:40");
  const { events, timers } = engine(toIso(detected));
  ingestLarFeedback(events, { submission_id: "S-1", feedback: [{ eventId: "ev-1", fnmaLoanNumber: FL, kind: "hard", code: "LPI_MISMATCH", message: "LPI mismatch" }], events: [{ event_id: "ev-1", loan_id: "L-1", fnma_loan_number: FL, event_type: "payment.contractual", family: "payment", activity_period: "2026-10", sequence: 1 }], received_at_ms: detected });
  createInvestorEvent(events, new SequenceAllocator({ "L-1": 2 }), { loan_id: "L-1", servicer_number: SN, fnma_loan_number: FL, event_type: "payment.contractual", effective_date: D("2026-10-14"), processed_at_ms: detected, payload: { ...P, action_date: D("2026-10-14") }, mode: "legacy", open_periods: ["2026-10"], actor: { kind: "human", id: "ops-7" } });
  const triage = timers.byCode("FNMA_IRM_REJECT_TRIAGE_4H")[0]!, correction = timers.byCode("FNMA_IRM_NONREMOVAL_CORRECTION_BD1_2000")[0]!, lar = timers.byCode("FNMA_C4301_LAR_NONREMOVAL_NEXTBD_2000")[0]!;
  assert.equal(toIso(triage.dueAt!), toIso(at("2026-10-14", "13:40"))); assert.equal(toIso(correction.dueAt!), toIso(at("2026-11-02", "20:00"))); assert.equal(toIso(lar.dueAt!), toIso(at("2026-10-15", "20:00")));
  const fired = ["FNMA_C4301_LAR_NONREMOVAL_NEXTBD_2000", "FNMA_IRM_NONREMOVAL_CORRECTION_BD1_2000", "FNMA_IRM_REJECT_TRIAGE_4H"];
  const breaches = timers.evaluate(toIso(at("2026-11-02", "20:01")));
  assert.deepEqual(breaches.map((b) => b.def.code).filter((c) => fired.includes(c)).sort(), fired);
  assert.deepEqual([triage.status, correction.status, lar.status], ["breached", "breached", "breached"]);
  // the toggle-off queue: the human's triage writes the same decision record through the same emitter, and it satisfies the (late) SLA the same way
  const h = recordTriage(events, { event_id: "ev-1", loan_id: "L-1", exception_code: "LPI_MISMATCH", root_cause: "ledger_error", evidence: ["doc-1"], action: "section2_correction", deadline_at: base.deadline_at, confidence: 1, rule_set_version: "irm-2026-09", actor: { kind: "human", id: "ops-7" }, agent_enabled: false, triaged_at_ms: at("2026-11-02", "20:05") });
  assert.deepEqual(Object.keys(h.record), [...LAR_DECISION_FIELDS]); assert.equal(h.worked_by, "human"); assert.equal(h.event.payload.worked_by, "human"); assert.equal(triage.status, "satisfied_late");
  assert.throws(() => recordTriage(events, { event_id: "ev-1", loan_id: "L-1", exception_code: "LPI_MISMATCH", root_cause: "ledger_error", evidence: [], action: "x", deadline_at: base.deadline_at, confidence: 1, rule_set_version: "v", actor: { kind: "agent", id: "investor-reporting" }, agent_enabled: false, triaged_at_ms: detected }), /worked by a human/);
});
test("5.1-T12: Given a soft reject on interest where Fannie Mae's expected interest ignores a mid-month curtailment, then the agent produces a Master Servicing package with pay history and the event closes `accepted_as_is` at period close with the decision record attached.", () => {
  const s = softRejectInterest({ our_interest_cents: 118750n, fnma_expected_cents: 125000n, curtailment_in_period: true, pay_history: [{ date: D("2026-10-05"), amount_cents: 158017n, kind: "contractual" }, { date: D("2026-10-15"), amount_cents: 1250000n, kind: "curtailment" }] });
  assert.equal(s.route, "master_servicing@fanniemae.com"); assert.equal(s.status, "rejected_soft"); assert.equal(s.package!.pay_history.length, 2); assert.equal(s.variance_cents, -6250n);
  const closed = closeSoftRejectAtPeriodClose({ fnma_adjusted: false, decision_id: "dec-1" });
  assert.equal(closed.status, "accepted"); assert.equal(closed.resolution, "accepted_as_is"); assert.equal(closed.decision_id, "dec-1");
  assert.equal(softRejectInterest({ our_interest_cents: 118750n, fnma_expected_cents: 125000n, curtailment_in_period: false, pay_history: [] }).route, "correct");
  // the soft reject arrives as LSDU feedback with Fannie Mae's expected figures and stays `rejected_soft`; at the BD2 close it resolves `accepted` / accepted_as_is with the decision attached — the non-removal correction clock's `accepted` outcome
  const { clock, events, timers } = engine(toIso(at("2026-10-16", "09:00")));
  const soft = ingestLarFeedback(events, { submission_id: "S-s", feedback: [{ eventId: "ev-s", fnmaLoanNumber: FL, kind: "soft", code: "INTEREST_VARIANCE", message: "expected interest 1250.00", fnmaExpected: { interest_cents: "125000" } }], events: [{ event_id: "ev-s", loan_id: "L-1", fnma_loan_number: FL, event_type: "payment.contractual", family: "payment", activity_period: "2026-10", sequence: 2 }], received_at_ms: at("2026-10-16", "09:00") });
  assert.deepEqual([soft.events[0]!.payload.status, soft.events[0]!.payload.fnma_expected], ["rejected_soft", { interest_cents: "125000" }]);
  const correction = timers.byCode("FNMA_IRM_NONREMOVAL_CORRECTION_BD1_2000")[0]!; assert.equal(toIso(correction.dueAt!), toIso(at("2026-11-02", "20:00")));
  clock.set(toIso(at("2026-11-02", "16:00")));
  const out = closeSoftRejectsAtPeriodClose(events, { soft_rejects: [{ event_id: "ev-s", loan_id: "L-1", family: "payment", activity_period: "2026-10", fnma_adjusted: false, decision_id: "dec-1" }], closed_at_ms: at("2026-11-02", "16:00") });
  assert.deepEqual([out[0]!.status, out[0]!.resolution], ["accepted", "accepted_as_is"]);
  assert.deepEqual([out[0]!.event.payload.status, out[0]!.event.payload.resolution, out[0]!.event.payload.decision_id], ["accepted", "accepted_as_is", "dec-1"]);
  assert.ok(eventMatches(sat("FNMA_IRM_NONREMOVAL_CORRECTION_BD1_2000"), out[0]!.event)); assert.equal(correction.status, "satisfied");
});

test("5.1 worked example: S/S MBS $250,000.00 at 6.500%/PTR 6.000%, P&I $1,580.17 → LAR 96 interest $1,250.00, principal $226.00, UPB $249,774.00", () => {
  const m = scheduledMonth(25000000n, "6.500", "6.000", 158017n);
  assert.equal(m.gross_interest_cents, 135417n); assert.equal(m.scheduled_principal_cents, 22600n); assert.equal(m.ending_scheduled_upb_cents, 24977400n); assert.equal(m.fnma_interest_cents, 125000n);
});
test("5.1 compensatory-fee ladder (A1-4.2-01): first instance the greater of $250 or $50/loan up to $5,000; second $500/$50 up to $10,000; each subsequent $1,000/$50 up to $15,000", () => {
  assert.equal(compFeeLadder(1, 3).fee_cents, 25_000n); assert.equal(compFeeLadder(1, 120).fee_cents, 500_000n);
  assert.equal(compFeeLadder(2, 12).fee_cents, 60_000n); assert.equal(compFeeLadder(2, 250).fee_cents, 1_000_000n);
  assert.equal(compFeeLadder(3, 2).fee_cents, 100_000n); assert.equal(compFeeLadder(3, 400).fee_cents, 1_500_000n); assert.equal(compFeeLadder(7, 1).rung, 3);
  assert.throws(() => compFeeLadder(0, 1), RangeError);
});
test("5.1 period anchors and correction windows: the October 2026 period opens the BD2 15:00 bulk cutoff, BD2 17:00 close, BD1 20:00 / BD2 17:00 correction clocks and the LAR 89 / TT 32 / deferral anchors", () => {
  const a = periodAnchors(D("2026-10-15"));
  assert.deepEqual([a.period, a.period_start, a.period_end, a.bd1_following, a.bd2_following, a.ired_on, a.ss_draft_on, a.sa_draft_on, a.gfee_draft_on, a.pool_draft_on, a.mbsx_bd4_on, a.gfee_bill_due_on], ["2026-10", "2026-10-01", "2026-10-31", "2026-11-02", "2026-11-03", "2026-10-22", "2026-11-18", "2026-11-20", "2026-11-06", "2026-11-06", "2026-11-05", "2026-11-05"]);
  assert.equal(a.close_at, toIso(bd2CloseMs(D("2026-11-01")))); assert.equal(a.bulk_cutoff_at, toIso(at("2026-11-03", "15:00")));
  const { clock, events, timers } = engine("2026-10-01T09:00:00.000Z");
  const opened = openReportingPeriod(events, { month_of: D("2026-10-01"), servicer_number: SN, loans: [{ loan_id: "L-1", fnma_loan_number: FL, reporting: "summary" }] });
  assert.deepEqual(opened.opened.payload.period_end, a.period_end);
  const due = (code: string) => toIso(timers.byCode(code)[0]!.dueAt!);
  assert.equal(due("FNMA_IRM_BULK_CUTOFF_BD2_1500"), toIso(at("2026-11-03", "15:00"))); assert.equal(due("FNMA_IRM_PERIOD_CLOSE_BD2_1700"), toIso(at("2026-11-03", "17:00"))); assert.equal(due("FNMA_LL202605_PERIOD_CLOSE_BD2_1700"), toIso(at("2026-11-03", "17:00")));
  assert.equal(due("FNMA_LL202605_NOPAYMENT_CD22"), toIso(at("2026-10-22", "23:59"))); assert.equal(due("FNMA_IRM_LAR_IRED_CD22_2000"), toIso(at("2026-10-22", "20:00")));
  // exceptions detected on the 10th anchor on the period end, not the detection date: a removal reject → BD2 17:00 ET; a payment soft reject → BD1 20:00 ET; each opens a 4-hour triage SLA
  const excs = ingestLarFeedback(events, { submission_id: "S-x", received_at_ms: at("2026-10-10", "10:00"), feedback: [{ eventId: "rm-1", fnmaLoanNumber: FL, kind: "hard", code: "NIB_MISSING", message: "payoff must include the forbearance amount" }, { eventId: "pay-1", fnmaLoanNumber: FL, kind: "soft", code: "INTEREST_VARIANCE" }],
    events: [{ event_id: "rm-1", loan_id: "L-1", fnma_loan_number: FL, event_type: "removal.payoff", family: "removal", activity_period: "2026-10", sequence: 5 }, { event_id: "pay-1", loan_id: "L-1", fnma_loan_number: FL, event_type: "payment.contractual", family: "payment", activity_period: "2026-10", sequence: 6 }] });
  assert.equal(excs.exceptions.length, 2);
  assert.equal(due("FNMA_IRM_REMOVAL_CORRECTION_BD2_1700"), toIso(at("2026-11-03", "17:00"))); assert.equal(due("FNMA_IRM_NONREMOVAL_CORRECTION_BD1_2000"), toIso(at("2026-11-02", "20:00")));
  assert.equal(timers.byCode("FNMA_IRM_REMOVAL_CORRECTION_BD2_1700").length, 1, "a non-removal exception does not arm the removal correction clock"); assert.equal(timers.byCode("FNMA_IRM_REJECT_TRIAGE_4H").length, 2);
  // the superseding removal accepted on the 12th: rm-1 is superseded → the removal correction clock is satisfied, the payment one is not (its own resolution is still open)
  const sup = ingestLarFeedback(events, { submission_id: "S-y", received_at_ms: at("2026-10-12", "10:00"), feedback: [{ eventId: "rm-2", fnmaLoanNumber: FL, kind: "accepted" }], events: [{ event_id: "rm-2", loan_id: "L-1", fnma_loan_number: FL, event_type: "removal.payoff", family: "removal", activity_period: "2026-10", sequence: 7, supersedes_event_id: "rm-1" }] });
  const res = sup.events.find((e) => e.type === "investor_events.resolved")!;
  assert.ok(eventMatches(sat("FNMA_IRM_REMOVAL_CORRECTION_BD2_1700"), res)); assert.ok(!eventMatches(sat("FNMA_IRM_NONREMOVAL_CORRECTION_BD1_2000"), res));
  assert.deepEqual([timers.byCode("FNMA_IRM_REMOVAL_CORRECTION_BD2_1700")[0]!.status, timers.byCode("FNMA_IRM_NONREMOVAL_CORRECTION_BD1_2000")[0]!.status], ["satisfied", "armed"]);
  // MI termination (code 53) arms LAR 89 for BD2 17:00 ET of the month after the effective date; the accepted `mi.discontinuance` record satisfies it
  events.append({ type: "mi.terminated", loanId: "L-2", actor: SYSTEM, payload: { effective_on: "2026-10-20", lar89_action_code: "53", period_end_date: "2026-10-31" } });
  events.append({ type: "mi.evaluation.completed", loanId: "L-2", actor: SYSTEM, payload: { result: "eligible" } });
  assert.equal(timers.byCode("FNMA_IRM_LAR89_PERIOD_END").length, 1); assert.equal(due("FNMA_IRM_LAR89_PERIOD_END"), toIso(at("2026-11-03", "17:00")));
  const mi = ingestLarFeedback(events, { submission_id: "S-89", received_at_ms: at("2026-10-21", "10:00"), feedback: [{ eventId: "ie-89", fnmaLoanNumber: FL2, kind: "accepted" }], events: [{ event_id: "ie-89", loan_id: "L-2", fnma_loan_number: FL2, event_type: "mi.discontinuance", family: "mi", activity_period: "2026-10", sequence: 1 }] });
  assert.ok(eventMatches(sat("FNMA_IRM_LAR89_PERIOD_END"), mi.events[0]!)); assert.equal(timers.byCode("FNMA_IRM_LAR89_PERIOD_END")[0]!.status, "satisfied");
  // TT 32: §17.1's approval of the outbound batch (transfer_date 2026-12-01) → due 2026-11-16 (−15 CD); an inbound approval never arms it; the accepted TT 32 for the batch satisfies it
  events.append({ type: "transfer.batch.approved", aggregate: { kind: "transfer_batch", id: "B-1" }, actor: SYSTEM, payload: { batch_id: "B-1", direction: "out", type: "servicing_sale", transfer_date: "2026-12-01", loan_count: 1 } });
  events.append({ type: "transfer.batch.approved", aggregate: { kind: "transfer_batch", id: "B-in" }, actor: SYSTEM, payload: { batch_id: "B-in", direction: "in", transfer_date: "2026-12-01" } });
  const tt32 = timers.byCode("FNMA_IRM_TT32_15CD"); assert.equal(tt32.length, 1); assert.equal(tt32[0]!.dueDate, "2026-11-16");
  const tt = ingestLarFeedback(events, { submission_id: "S-32", received_at_ms: at("2026-11-10", "10:00"), feedback: [{ eventId: "ie-32", fnmaLoanNumber: FL, kind: "accepted" }], events: [{ event_id: "ie-32", loan_id: "L-1", fnma_loan_number: FL, event_type: "transfer.servicing", family: "transfer", activity_period: "2026-11", sequence: 8, transfer_batch_id: "B-1" }] });
  assert.equal(tt.events[0]!.aggregate?.id, "B-1"); assert.ok(eventMatches(sat("FNMA_IRM_TT32_15CD"), tt.events[0]!)); assert.equal(tt32[0]!.status, "satisfied");
  // deferral: SMDU's acceptance of the October payment-deferral case → the contractual-payment LAR accepted at least 1 fannie_et BD before Oct 31 = Fri Oct 30
  const smdu = ingestSmduDeferralAcceptance(events, { loan_id: "L-4", smdu_case_id: "SMDU-1", program: "payment_deferral", decision_status: "accepted", processing_month: "2026-10", effective_date: D("2026-11-01"), accepted_at_ms: at("2026-10-05", "10:00") });
  assert.deepEqual([smdu.processing_month_end, smdu.contractual_lar_due_on], ["2026-10-31", "2026-10-30"]); assert.equal(timers.byCode("FNMA_IRM_DEFERRAL_LAR_BEFORE_EOM_1BD")[0]!.dueDate, "2026-10-30");
  assert.throws(() => ingestSmduDeferralAcceptance(events, { loan_id: "L-4", smdu_case_id: "SMDU-2", program: "flex_modification", decision_status: "accepted", processing_month: "2026-10", effective_date: D("2026-11-01"), accepted_at_ms: at("2026-10-05", "10:00") }), RangeError);
  assert.throws(() => ingestSmduDeferralAcceptance(events, { loan_id: "L-4", smdu_case_id: "SMDU-3", program: "payment_deferral", decision_status: "declined", processing_month: "2026-10", effective_date: D("2026-11-01"), accepted_at_ms: at("2026-10-05", "10:00") }), RangeError);
  const def = ingestLarFeedback(events, { submission_id: "S-d", received_at_ms: at("2026-10-28", "10:00"), feedback: [{ eventId: "ie-def", fnmaLoanNumber: "4000000004", kind: "accepted" }], events: [{ event_id: "ie-def", loan_id: "L-4", fnma_loan_number: "4000000004", event_type: "payment.contractual", family: "payment", activity_period: "2026-10", sequence: 2, deferral_pending: true }] });
  assert.ok(eventMatches(sat("FNMA_IRM_DEFERRAL_LAR_BEFORE_EOM_1BD"), def.events[0]!)); assert.equal(timers.byCode("FNMA_IRM_DEFERRAL_LAR_BEFORE_EOM_1BD")[0]!.status, "satisfied");
  // month end → the comp-fee watch arms (recurring); its report is the satisfying fact. Both are `recurring` rows, and TimerEngine.onEvent re-arms a
  // recurring instance inside its own satisfaction loop (kernel defect, reported), so the report is produced in its own store and proven on the pattern.
  clock.set(toIso(at("2026-10-31", "23:00")));
  assert.throws(() => monthEnd(events, { month_of: D("2026-10-01"), servicer_number: SN, now_ms: at("2026-10-30", "23:00") }), RangeError);
  const me = monthEnd(events, { month_of: D("2026-10-01"), servicer_number: SN, now_ms: at("2026-10-31", "23:00") });
  assert.equal(me.event.payload.month_end, "2026-10-31"); assert.equal(timers.byCode("FNMA_A14201_COMPFEE_WATCH").length, 1);
  const watch = compensatoryFeeWatch(new MemoryEventStore(clock), { servicer_number: SN, period: "2026-10", instances: [{ kind: "late_lar", loans: 3, occurred_on: D("2026-10-15") }, { kind: "late_lar", loans: 120, occurred_on: D("2026-10-28") }], prior_instances_within_year: 0, produced_at_ms: at("2026-11-02", "09:00") });
  assert.deepEqual(watch.lines.map((l) => [l.instance_number, l.fee_cents]), [[1, 25_000n], [2, 600_000n]]);   // $250 (greater of $250 / 3 × $50); second instance 120 × $50 = $6,000 under the $10,000 cap
  assert.equal(watch.exposure_cents, 625_000n); assert.ok(eventMatches(sat("FNMA_A14201_COMPFEE_WATCH"), watch.event));
  // BD2 close: an open hard reject blocks the close (officer); the clean checklist closes the period — both close rows satisfied — and escrow events open the attestation window (BD3 Nov 4 → BD2 Dec 2 17:00 ET)
  clock.set(toIso(at("2026-11-03", "16:30")));
  const facts = { period: "2026-10", active_loans: 1, loans_with_accepted_event_or_none: 1, open_hard_or_invalid_rejects: 0, removals: [], trial_balance_diff_loans: 0, soft_rejects_without_triage: 0, cash_position_variance_cents: 0n, delinquency_file_accepted: true, escrow_attestation_prepared: true as const };
  const blocked = closeReportingPeriod(events, { servicer_number: SN, facts: { ...facts, open_hard_or_invalid_rejects: 1 }, escrow_events: true, closed_at_ms: at("2026-11-03", "16:00") });
  assert.deepEqual([blocked.closed, blocked.escalation, blocked.event.type], [false, "officer", "investor_reporting_periods.close_blocked"]);
  assert.equal(timers.byCode("FNMA_IRM_PERIOD_CLOSE_BD2_1700")[0]!.status, "armed");
  const closed = closeReportingPeriod(events, { servicer_number: SN, facts, escrow_events: true, closed_at_ms: at("2026-11-03", "16:30") });
  assert.equal(closed.closed, true); assert.deepEqual(closed.attestation_window, { opens_on: "2026-11-04", close_on: "2026-12-02" });
  assert.ok(eventMatches(sat("FNMA_IRM_PERIOD_CLOSE_BD2_1700"), closed.event)); assert.ok(eventMatches(sat("FNMA_LL202605_PERIOD_CLOSE_BD2_1700"), closed.event));
  assert.deepEqual([timers.byCode("FNMA_IRM_PERIOD_CLOSE_BD2_1700")[0]!.status, timers.byCode("FNMA_LL202605_PERIOD_CLOSE_BD2_1700")[0]!.status], ["satisfied", "satisfied"]);
  const att = timers.byCode("FNMA_LL202605_ESCROW_ATTEST_BD2")[0]!; assert.equal(toIso(att.dueAt!), toIso(at("2026-12-02", "17:00")));
  assert.throws(() => completeEscrowAttestation(events, { servicer_number: SN, period: "2026-10", evidence_document_id: "", completed_at_ms: at("2026-11-20", "10:00"), actor: OPERATOR }), RangeError, "no attestation without evidence");
  assert.throws(() => completeEscrowAttestation(events, { servicer_number: SN, period: "2026-10", evidence_document_id: "doc-att-1", completed_at_ms: at("2026-11-20", "10:00"), actor: AGENT }), RangeError, "a UI-only submission is the portal operator's act");
  const done = completeEscrowAttestation(events, { servicer_number: SN, period: "2026-10", evidence_document_id: "doc-att-1", evidence_sha256: "ab12", submission_id: "SP-77", completed_at_ms: at("2026-11-20", "10:00"), actor: OPERATOR });
  assert.equal(done.payload.task, "escrow_attestation"); assert.ok(eventMatches(sat("FNMA_LL202605_ESCROW_ATTEST_BD2"), done)); assert.equal(att.status, "satisfied");
});
