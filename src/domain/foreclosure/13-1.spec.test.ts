// 13.1 120-day pre-foreclosure prohibition
// spec/sections/13-foreclosure/13-1-120-day-pre-foreclosure-prohibition.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, addDays, type PlainDate } from "../../kernel/calendar/date.ts";
import { MemoryEventStore, FixedClock, type Actor } from "../../kernel/events/index.ts";
import { eventMatches } from "../../kernel/events/match.ts";
import { TimerEngine } from "../../kernel/timers/engine.ts";
import { EntityStore } from "../../app/tools.ts";
import { EscalationService } from "../../app/escalations.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { delinquencyMilestone } from "../early-intervention/ops.ts";
import { occupancyDefault, preFilingAppHold, exceptionGround, nyFirstNoticeGate, refusedReferral, ruleSetSwap, transferredFirstFiling, gateSweep, nonPrDeadlineLadder } from "./ops.ts";
import { gate120, nonPrDeadline } from "./gates.ts";
import { referralEligible, type Gates } from "./referral.ts";
import { sweepDelinquencyCounters, assertGateOpen, referLoan, authorizeFirstNotice, transferInForeclosureState, bankruptcyStayEnded, wireForeclosureGateReactors_13_1, principalResidence, GATE_120, GATE_F2, GATE_BK, GATE_NY, GATE_FIRST_NOTICE_MADE, type Deps, type Refusal, type Assertion } from "./ops-13-1.ts";

// ---- harness: the 13.1 ops over an in-memory event store, entity store and a TimerEngine over the overridden registry
// (only 13.1 rows arm). Every timer the T-ids name is armed by an event the ops append and satisfied by the event they emit.
const OPS: Actor = { kind: "agent", id: "foreclosure-ops" };
const REG = loadOverriddenRegistry();
const iso = (d: PlainDate, hhmm = "05:05"): string => `${d}T${hhmm}:00.000Z`;   // 00:05 loan tz (ET) = 05:05Z in DST months
function world(loan: Record<string, unknown>, loanId = "L-131", start = iso(D("2026-01-02"))) {
  const clock = new FixedClock(start); const events = new MemoryEventStore(clock);
  const timers = new TimerEngine(REG, events, { processes: ["13.1"] });
  const store = new EntityStore(); const escalations = new EscalationService(events, clock);
  store.put("loans", loanId, { loan_id: loanId, ...loan }, OPS, start);
  const d: Deps = { events, store, escalations };
  const at = (day: PlainDate) => { clock.set(iso(day)); return { actor: OPS, now: iso(day) }; };
  const sweep = (day: PlainDate) => sweepDelinquencyCounters(d, { loan_id: loanId, ...at(day) });
  const ofType = (type: string) => events.byLoan(loanId).filter((e) => e.type === type);
  return { clock, events, timers, store, escalations, d, at, sweep, ofType, loanId };
}
const day = (eu: PlainDate, n: number): PlainDate => addDays(eu, n);
const isRefusal = (r: object): r is Refusal & { assertion: Assertion } => (r as Refusal).refused === true;

test("13.1-T1: Given due date Jan. 1, 2026 unpaid, When the sweep runs May 1, Then gate closed (day 120); When May 2, Then open and `foreclosure.gate.opened` emitted once.", () => {
  const eu = D("2026-01-01");
  const may1 = gateSweep({ today: D("2026-05-01"), earliest_unpaid_due: eu, principal_residence: true, previous_state: "closed" });
  assert.equal(may1.state, "closed"); assert.equal(may1.days, 120); assert.deepEqual(may1.events, []);
  const may2 = gateSweep({ today: D("2026-05-02"), earliest_unpaid_due: eu, principal_residence: true, previous_state: may1.state });
  assert.equal(may2.state, "open"); assert.equal(may2.days, 121); assert.equal(may2.opens_on, "2026-05-02"); assert.deepEqual(may2.events, [{ type: "foreclosure.gate.opened", code: "REGX_1024_41F1_120_DAY_GATE", on: "2026-05-02" }]);
  const may3 = gateSweep({ today: D("2026-05-03"), earliest_unpaid_due: eu, principal_residence: true, previous_state: may2.state });
  assert.equal(may3.state, "open"); assert.deepEqual(may3.events, [], "emitted once — not again while the gate stays open");
  assert.equal(gate120(D("2026-06-30"), D("2026-03-01"), true).state, "open"); assert.equal(gate120(D("2026-06-29"), D("2026-03-01"), true).state, "closed");
  // The daily 00:05 sweep over the event store: the loan enters delinquency on Jan. 2 (day 1) — `delinquency.counters.updated{entered_delinquency=true}`
  // arms REGX_1024_41F1_120_DAY_GATE on the earliest unpaid due date; May 1 (day 120) leaves it closed; May 2 (day 121) appends
  // `foreclosure.gate.opened{code}` once, with its evaluation row, and that event satisfies the armed gate instance.
  const w = world({ earliest_unpaid_due: eu, principal_residence: true, state: "TX" });
  const jan2 = w.sweep(D("2026-01-02"));
  assert.equal(jan2.regx_days_delinquent, 1); assert.equal(jan2.entered_delinquency, true); assert.equal(jan2.state, "closed"); assert.deepEqual(jan2.events, []);
  const armed = w.timers.byCode(GATE_120); assert.equal(armed.length, 1); assert.equal(armed[0]!.status, "armed"); assert.equal(armed[0]!.anchorDate, eu); assert.equal(armed[0]!.armedByEventId, jan2.counters_event_id); assert.equal(armed[0]!.note, "evaluator:13.1.preForeclosureReviewPeriodElapsed");
  const s1 = w.sweep(D("2026-05-01")); assert.equal(s1.regx_days_delinquent, 120); assert.equal(s1.state, "closed"); assert.equal(s1.opens_on, "2026-05-02"); assert.deepEqual(s1.events, []); assert.equal(s1.entered_delinquency, false, "already delinquent — arms once");
  assert.equal(w.timers.byCode(GATE_120).length, 1); assert.equal(armed[0]!.status, "armed"); assert.equal(w.store.get("loans", w.loanId)!.data.fc_120_day_open_on, "2026-05-02");
  const s2 = w.sweep(D("2026-05-02")); assert.equal(s2.regx_days_delinquent, 121); assert.equal(s2.state, "open"); assert.deepEqual(s2.events, ["foreclosure.gate.opened"]); assert.equal(s2.evaluation_ids.length, 1);
  const opened = w.ofType("foreclosure.gate.opened"); assert.equal(opened.length, 1); assert.equal(opened[0]!.payload.code, GATE_120); assert.equal(opened[0]!.payload.on, "2026-05-02"); assert.equal(opened[0]!.payload.reason, "day_121_reached"); assert.equal(opened[0]!.causationId, s2.counters_event_id);
  assert.ok(eventMatches(REG.get(GATE_120)!.satisfiedPattern!, opened[0]!)); assert.equal(armed[0]!.status, "satisfied"); assert.equal(armed[0]!.satisfiedByEventId, opened[0]!.id);
  const row = w.store.get("foreclosure_gate_evaluations", s2.evaluation_ids[0]!)!.data; assert.equal(row.gate_code, GATE_120); assert.equal(row.result, "open"); assert.equal(row.reason_code, "day_121_reached"); assert.equal(row.evaluated_at, iso(D("2026-05-02"))); assert.equal((row.inputs as { regx_days_delinquent: number }).regx_days_delinquent, 121);
  const s3 = w.sweep(D("2026-05-03")); assert.equal(s3.state, "open"); assert.deepEqual(s3.events, []); assert.equal(w.ofType("foreclosure.gate.opened").length, 1, "emitted once");
  assert.equal(w.ofType("delinquency.counters.updated").length, 4, "one counters event per sweep");
});
test("13.1-T2: Given day 121 open and a full payment credited to Jan. 1 on May 3, Then gate closes (anchor Feb. 1, days 91) and re-opens June 2.", () => {
  assert.equal(gate120(D("2026-05-02"), D("2026-01-01"), true).state, "open");
  const moved = gateSweep({ today: D("2026-05-03"), earliest_unpaid_due: D("2026-02-01"), principal_residence: true, previous_state: "open" });
  assert.equal(moved.state, "closed"); assert.equal(moved.days, 91); assert.equal(moved.opens_on, "2026-06-02"); assert.deepEqual(moved.events, [{ type: "foreclosure.gate.closed", code: "REGX_1024_41F1_120_DAY_GATE", on: "2026-05-03" }]);
  assert.equal(gate120(D("2026-06-01"), D("2026-02-01"), true).state, "closed"); assert.equal(gate120(D("2026-06-02"), D("2026-02-01"), true).state, "open");
  // Over the event store: the May 2 opening, then 2.1's FIFO crediting of the Jan. 1 installment moves the loan row's anchor to
  // Feb. 1 and `payment.applied` re-sweeps (reactor) — `foreclosure.gate.closed{code, reason=anchor_moved}` on May 3 (days 91),
  // a refused referral until June 1, and the re-opening on June 2 (Feb. 1 + 121).
  const w = world({ earliest_unpaid_due: D("2026-01-01"), principal_residence: true, state: "TX" }); const off = wireForeclosureGateReactors_13_1(w.d);
  w.sweep(D("2026-01-02")); w.sweep(D("2026-05-02")); assert.equal(w.ofType("foreclosure.gate.opened").length, 1);
  w.store.put("loans", w.loanId, { earliest_unpaid_due: D("2026-02-01") }, OPS, iso(D("2026-05-03")));
  w.events.append({ type: "payment.applied", loanId: w.loanId, actor: OPS, occurredAt: iso(D("2026-05-03"), "14:00"), payload: { loan_id: w.loanId, credited_to_due_date: "2026-01-01", earliest_unpaid_due_date: "2026-02-01", full_periodic_payment: true } });
  const closed = w.ofType("foreclosure.gate.closed"); assert.equal(closed.length, 1); assert.equal(closed[0]!.payload.code, GATE_120); assert.equal(closed[0]!.payload.reason, "anchor_moved"); assert.equal(closed[0]!.payload.on, "2026-05-03"); assert.equal(closed[0]!.payload.regx_days_delinquent, 91); assert.equal(closed[0]!.payload.opens_on, "2026-06-02");
  assert.equal(w.store.get("loans", w.loanId)!.data.fc_120_day_open_on, "2026-06-02");
  const june1 = referLoan(w.d, { loan_id: w.loanId, firm_id: "firm-1", ...w.at(D("2026-06-01")) }); assert.ok(isRefusal(june1)); assert.equal(june1.code, GATE_120); assert.equal(june1.opens_on, "2026-06-02");
  const june2 = w.sweep(D("2026-06-02")); assert.equal(june2.state, "open"); assert.equal(june2.regx_days_delinquent, 121); assert.deepEqual(june2.events, ["foreclosure.gate.opened"]); assert.equal(w.ofType("foreclosure.gate.opened").length, 2);
  assert.equal(june2.entered_delinquency, false, "the delinquency never ended — no fresh 120-day wait, no re-arming");
  assert.equal(w.timers.byCode(GATE_120).length, 1);
  off();
});
test("13.1-T3: Given non-principal residence, When `foreclosure.refer` at day 100, Then `REGX_1024_41F1_120_DAY_GATE=not_applicable`, `FNMA_E1202_NONPR_REFER_BY_120` due day 120, Fannie Mae/state gates still evaluated.", () => {
  const eu = D("2026-03-01"); const day100 = D("2026-06-09");
  const g = gate120(day100, eu, false); assert.equal(g.state, "not_applicable"); assert.equal(g.days, 100);
  assert.equal(nonPrDeadline(eu), "2026-06-29");
  const ladder = nonPrDeadlineLadder({ earliest_unpaid_due: eu, events: [], today: day100 }); assert.equal(ladder.timer, "FNMA_E1202_NONPR_REFER_BY_120"); assert.equal(ladder.deadline, "2026-06-29"); assert.equal(ladder.status, "running"); assert.equal(ladder.breached, false);
  const gates: Gates = { regx_120: true, regx_prefiling: true, no_first_filing_41k2: true, fnma_121: true, bk_stay: false, scra: false, dmdc_age_days: 10, disaster_approval: true, litigation_hold: false, environmental_hold: false, mn_dual_track: false, title_hold: false, package_ready: true };
  assert.deepEqual(referralEligible("refer", { ...gates, scra: true, dmdc_age_days: 31 }).blocked_by, ["scra", "SCRA_DMDC_STALE_30"], "Fannie Mae/state gates are still evaluated with the Reg X gate not applicable");
  assert.deepEqual(referralEligible("refer", { ...gates, disaster_approval: false, mn_dual_track: true }).blocked_by, ["disaster_approval", "mn_dual_track"]);
  // Over the event store: an investment property (principal_residence=false) — the sweep projects `fc_referral_deadline_on` = eu + 120
  // and never opens the Reg X gate; 11.1's day-90 milestone `loan.delinquency.day_reached{fnma_day=90, principal_residence=false}`
  // arms FNMA_E1202_NONPR_REFER_BY_120 due day 120 (2026-06-29, sev 2 → foreclosure-ops); `foreclosure.refer` at day 100 asserts
  // the gates (120-day gate not_applicable) and the `foreclosure.referral.sent` it appends satisfies the deadline.
  const w = world({ earliest_unpaid_due: eu, principal_residence: false, occupancy_type: "investment", state: "TX" }, "L-131-NPR");
  assert.equal(principalResidence(w.store.get("loans", w.loanId)!.data), false);
  const s = w.sweep(D("2026-03-02")); assert.equal(s.state, "not_applicable"); assert.equal(s.principal_residence, false); assert.equal(w.timers.byCode(GATE_120).length, 0, "the Reg X gate never arms off scope");
  assert.equal(w.store.get("loans", w.loanId)!.data.fc_referral_deadline_on, "2026-06-29"); assert.equal(w.store.get("loans", w.loanId)!.data.fc_120_day_open_on, null); assert.equal(w.store.get("loans", w.loanId)!.data.regx_lossmit_scope, false);
  const m = delinquencyMilestone({ today: D("2026-05-30"), earliest_unpaid_due: eu, principal_residence: false, fnma_delinquency_days: 90 }); assert.equal(m.milestone, 90);
  w.clock.set(iso(D("2026-05-30"))); w.events.append({ type: m.events[0]!.type, loanId: w.loanId, actor: OPS, payload: m.events[0]!.payload });
  const deadline = w.timers.byCode("FNMA_E1202_NONPR_REFER_BY_120"); assert.equal(deadline.length, 1); assert.equal(deadline[0]!.status, "armed"); assert.equal(deadline[0]!.anchorDate, eu); assert.equal(deadline[0]!.dueDate, "2026-06-29");
  assert.equal(REG.get("FNMA_E1202_NONPR_REFER_BY_120")!.severity.level, 2); assert.deepEqual(REG.get("FNMA_E1202_NONPR_REFER_BY_120")!.severity.escalateTo, ["foreclosure-ops"]);
  const day100Sweep = w.sweep(day100); assert.equal(day100Sweep.regx_days_delinquent, 100); assert.deepEqual(w.ofType("foreclosure.gate.opened"), []);
  const r = referLoan(w.d, { loan_id: w.loanId, firm_id: "firm-1", ...w.at(day100) }); assert.ok(!isRefusal(r)); assert.equal(r.day, 100); assert.equal(r.referred_on, day100); assert.equal(r.principal_residence, false);
  const a = assertGateOpen(w.d, { loan_id: w.loanId, step: "refer", ...w.at(day100) }); assert.equal(a.gates.find((x) => x.code === GATE_120)!.result, "not_applicable"); assert.equal(a.gates.find((x) => x.code === GATE_F2)!.result, "open"); assert.equal(a.open, true);
  const sent = w.ofType("foreclosure.referral.sent"); assert.equal(sent.length, 1); assert.equal(sent[0]!.payload.referred_on, day100); assert.equal(sent[0]!.payload.regx_days_delinquent, 100); assert.ok(Array.isArray(sent[0]!.payload.gates_snapshot) && (sent[0]!.payload.gates_snapshot as unknown[]).length > 0, "every referral message carries the gates_snapshot");
  assert.ok(eventMatches(REG.get("FNMA_E1202_NONPR_REFER_BY_120")!.satisfiedPattern!, sent[0]!)); assert.equal(deadline[0]!.status, "satisfied"); assert.equal(deadline[0]!.satisfiedByEventId, sent[0]!.id);
  assert.equal(w.store.get("foreclosure_cases", r.case_id)!.data.referral_sent_at, iso(day100), "E-1.2-02: the referral date is kept in the loan file");
  assert.deepEqual(w.timers.evaluate(iso(D("2026-06-30"))), [], "satisfied before day 120 — nothing breaches");
  // Not referred by day 120 ⇒ the deadline breaches on day 120 with sev 2 → foreclosure-ops.
  const w2 = world({ earliest_unpaid_due: eu, principal_residence: false, state: "TX" }, "L-131-NPR-2");
  w2.clock.set(iso(D("2026-05-30"))); w2.events.append({ type: m.events[0]!.type, loanId: w2.loanId, actor: OPS, payload: m.events[0]!.payload });
  assert.deepEqual(w2.timers.evaluate(iso(D("2026-06-29"), "12:00")), []);
  const breaches = w2.timers.evaluate(iso(D("2026-06-30"))); assert.equal(breaches.length, 1); assert.equal(breaches[0]!.instance.code, "FNMA_E1202_NONPR_REFER_BY_120"); assert.equal(breaches[0]!.severity, 2); assert.deepEqual(breaches[0]!.escalateTo, ["foreclosure-ops"]);
});
test("13.1-T3a: **(E-1.2-02 BRP exception ladder)** Given a non-principal-residence loan at day 118 and a **complete** BRP received day 119, Then `FNMA_E1202_NONPR_REFER_BY_120` is **suspended** (not breached) for the 30-day evaluation; a retention offer on day 130 extends the suspension 14 days; acceptance with a first payment due Feb. 1 extends it to Feb. 28; the first TPP payment extends it until `lossmit.plan.breached`; each rung writes a `foreclosure_deadline_suspensions` row and no sev-2 fires while suspended.", () => {
  const eu = D("2026-03-01");   // day 118 = 2026-06-27, day 119 = 2026-06-28, day 120 = 2026-06-29, day 130 = 2026-07-09
  const a = nonPrDeadlineLadder({ earliest_unpaid_due: eu, events: [{ kind: "complete_brp", on: D("2026-06-28"), event_id: "evt-brp" }], today: D("2026-07-01") });
  assert.equal(a.status, "suspended"); assert.equal(a.breached, false); assert.equal(a.breach, null); assert.equal(a.suspensions.length, 1);
  assert.deepEqual(a.suspensions[0], { timer: "FNMA_E1202_NONPR_REFER_BY_120", rung: "a_eval_30", armed_by_event_id: "evt-brp", from: "2026-06-28", resume_condition: "lossmit.determination.sent (≤30-day evaluation)", resumes_on: "2026-07-28", ended_on: null, end_reason: null });
  const events = [{ kind: "complete_brp" as const, on: D("2026-06-28"), event_id: "evt-brp" }, { kind: "retention_offer" as const, on: D("2026-07-09"), event_id: "evt-offer" }, { kind: "accepted_with_first_payment_due" as const, on: D("2026-07-20"), first_payment_due: D("2027-02-01"), event_id: "evt-accept" }, { kind: "first_payment_received" as const, on: D("2027-02-10"), event_id: "evt-pay" }];
  const d = nonPrDeadlineLadder({ earliest_unpaid_due: eu, events, today: D("2027-03-15") });
  assert.deepEqual(d.suspensions.map((r) => [r.rung, r.from, r.resumes_on, r.ended_on]), [["a_eval_30", "2026-06-28", "2026-07-28", "2026-07-09"], ["b_offer_14", "2026-07-09", "2026-07-23", "2026-07-20"], ["c_accepted_month_end", "2026-07-20", "2027-02-28", "2027-02-10"], ["d_performing_until_breach", "2027-02-10", "on_breach", null]]);
  assert.equal(d.status, "suspended"); assert.equal(d.breached, false); assert.equal(d.breach, null, "no sev-2 while suspended");
  const breached = nonPrDeadlineLadder({ earliest_unpaid_due: eu, events: [...events, { kind: "plan_breached", on: D("2027-04-01") }], today: D("2027-04-02") });
  assert.equal(breached.suspended, false); assert.equal(breached.suspensions[3]!.ended_on, "2027-04-01"); assert.match(breached.suspensions[3]!.end_reason!, /plan\.breached/);
});
test("13.1-T3b: **(exception boundaries)** Given the same loan but the borrower sends only a **written inquiry**, or a BRP that is still **incomplete** at day 120, Then no suspension is written, the deadline breaches on day 120 with sev 2 and 13.5 exposure; and given an offer whose 14-day response window expires with no acceptance, Then the suspension ends that day (E-3.2-01: no delay once the response time frame has expired) rather than continuing.", () => {
  const eu = D("2026-03-01"); const day120 = D("2026-06-29");
  const inquiry = nonPrDeadlineLadder({ earliest_unpaid_due: eu, events: [{ kind: "inquiry", on: D("2026-06-28") }], today: day120 });
  assert.deepEqual(inquiry.suspensions, []); assert.equal(inquiry.day, 120); assert.equal(inquiry.breached, true); assert.deepEqual(inquiry.breach, { severity: "sev2", to: "foreclosure-ops", comp_fee_exposure_flag: true }); assert.equal(inquiry.status, "breached");
  const incomplete = nonPrDeadlineLadder({ earliest_unpaid_due: eu, events: [{ kind: "incomplete_brp", on: D("2026-06-28") }], today: day120 });
  assert.deepEqual(incomplete.suspensions, []); assert.equal(incomplete.breached, true); assert.equal(incomplete.breach!.severity, "sev2");
  const expired = nonPrDeadlineLadder({ earliest_unpaid_due: eu, events: [{ kind: "complete_brp", on: D("2026-06-28") }, { kind: "retention_offer", on: D("2026-07-04") }], today: D("2026-07-19") });
  assert.equal(expired.suspensions[1]!.rung, "b_offer_14"); assert.equal(expired.suspensions[1]!.resumes_on, "2026-07-18"); assert.equal(expired.suspensions[1]!.ended_on, "2026-07-18"); assert.match(expired.suspensions[1]!.end_reason!, /E-3\.2-01/);
  assert.equal(expired.suspended, false); assert.equal(expired.breached, true, "the deadline resumes the day the window expires rather than continuing");
  assert.equal(nonPrDeadlineLadder({ earliest_unpaid_due: eu, events: [{ kind: "complete_brp", on: D("2026-06-28") }, { kind: "retention_offer", on: D("2026-07-04") }], today: D("2026-07-18") }).suspended, true);
});
test("13.1-T4: Given occupancy unknown, Then treated as principal residence; escalation to `human_agent` if the model concludes otherwise with confidence 0.85.", () => {
  assert.deepEqual(occupancyDefault({ occupancy: "unknown" }), { treated_as: "principal_residence", escalation: null });
  const r = occupancyDefault({ occupancy: "unknown", model_conclusion: { non_principal: true, confidence: 0.85 } });
  assert.equal(r.treated_as, "principal_residence"); assert.equal(r.escalation!.kind, "human_agent"); assert.match(r.escalation!.reason, /0\.85/);
  assert.equal(occupancyDefault({ occupancy: "unknown", model_conclusion: { non_principal: true, confidence: 0.95 } }).treated_as, "non_principal");
  // Rule 3 on the loan row: unknown/absent occupancy ⇒ principal residence ⇒ the 120-day gate applies (closed at day 100, no referral).
  assert.equal(principalResidence({ occupancy: "unknown" }), true); assert.equal(principalResidence({}), true); assert.equal(principalResidence({ occupancy_type: "second_home" }), false);
  const w = world({ earliest_unpaid_due: D("2026-03-01"), occupancy: "unknown", state: "TX" }, "L-131-UNK");
  const a = assertGateOpen(w.d, { loan_id: w.loanId, step: "refer", ...w.at(D("2026-06-09")) }); assert.equal(a.principal_residence, true); assert.equal(a.gates.find((x) => x.code === GATE_120)!.result, "closed"); assert.equal(a.gates.find((x) => x.code === GATE_120)!.opens_on, "2026-06-30");
  // State machine: `not_applicable` → `closed`/`open` when a verified change makes the property a principal residence — the
  // sweep that first finds the delinquent loan in scope arms the gate at the original anchor (counters never restart).
  const flip = world({ earliest_unpaid_due: D("2026-03-01"), occupancy_type: "investment", principal_residence: false, state: "TX" }, "L-131-FLIP", iso(D("2026-03-02")));
  const s0 = flip.sweep(D("2026-03-02")); assert.equal(s0.state, "not_applicable"); assert.equal(s0.entered_delinquency, true); assert.equal(flip.timers.byCode(GATE_120).length, 0, "off scope: nothing arms");
  flip.store.put("loans", flip.loanId, { occupancy_type: "primary", principal_residence: true }, { kind: "human", id: "u-specialist", role: "human_agent" }, iso(D("2026-05-01")));
  const s1 = flip.sweep(D("2026-05-01")); assert.equal(s1.principal_residence, true); assert.equal(s1.state, "closed"); assert.equal(s1.entered_delinquency, true, "a delinquent loan newly in 1024.30(c)(2) scope enters the gate's delinquency"); assert.equal(s1.opens_on, "2026-06-30");
  const armed = flip.timers.byCode(GATE_120); assert.equal(armed.length, 1); assert.equal(armed[0]!.anchorDate, "2026-03-01"); assert.equal(flip.sweep(D("2026-05-02")).entered_delinquency, false);
  flip.sweep(D("2026-06-30")); assert.equal(armed[0]!.status, "satisfied");
});
test('13.1-T5: Given complete application received day 100 and determination "ineligible" sent day 118 with 14-day appeal window, When referral attempted day 121, Then refused by `REGX_1024_41F2_PRE_FILING_APP_GATE` until day 133 (window expiry) or appeal denial.', () => {
  const eu = D("2026-03-01");
  const r = preFilingAppHold({ earliest_unpaid_due: eu, complete_received_on: day(eu, 100), determination_sent_on: day(eu, 118), appeal_available: true, referral_attempt_on: day(eu, 121) });
  assert.equal(r.day_of_attempt, 121); assert.equal(r.state, "closed"); assert.equal(r.opens_on, day(eu, 133)); assert.equal(r.opens_on, "2026-07-12"); assert.match(r.refusal!, /REGX_1024_41F2_PRE_FILING_APP_GATE until/);
  assert.equal(preFilingAppHold({ earliest_unpaid_due: eu, complete_received_on: day(eu, 100), determination_sent_on: day(eu, 118), appeal_available: true, referral_attempt_on: day(eu, 133) }).state, "open");
  assert.equal(preFilingAppHold({ earliest_unpaid_due: eu, complete_received_on: day(eu, 100), determination_sent_on: day(eu, 118), appeal_available: true, appeal_denied_on: day(eu, 125), referral_attempt_on: day(eu, 126) }).state, "open");
  // Over the event store: 12.x's `lossmit.application.completed` (day 100, before any first notice) arms the (f)(2) gate; the 120-day
  // gate is open at day 121 (2026-06-30) but `foreclosure.refer` is refused by REGX_1024_41F2_PRE_FILING_APP_GATE until day 133
  // (2026-07-12), with the refusal trail; on day 133 the referral goes; an appeal denied on day 125 opens it on day 126.
  const app = (extra: Record<string, unknown> = {}) => ({ loan_id: "L-131-F2", status: "complete", complete_received_on: day(eu, 100), determination_sent_on: day(eu, 118), determination: "ineligible", appeal_available: true, ...extra });
  const w = world({ earliest_unpaid_due: eu, principal_residence: true, state: "TX" }, "L-131-F2");
  w.sweep(D("2026-03-02")); w.sweep(day(eu, 121)); assert.equal(w.ofType("foreclosure.gate.opened").length, 1, "the 120-day gate itself is open at day 121");
  w.store.put("lossmit_applications", "app-1", app(), OPS, iso(day(eu, 100)));
  w.clock.set(iso(day(eu, 100), "15:00")); w.events.append({ type: "lossmit.application.completed", loanId: w.loanId, actor: OPS, payload: { application_id: "app-1", status: "complete", complete_date: day(eu, 100) } });
  const f2 = w.timers.byCode(GATE_F2); assert.equal(f2.length, 1); assert.equal(f2[0]!.status, "armed"); assert.equal(f2[0]!.note, "evaluator:13.1.preFilingAppGateOpen");
  const attempt = referLoan(w.d, { loan_id: w.loanId, firm_id: "firm-1", ...w.at(day(eu, 121)) });
  assert.ok(isRefusal(attempt)); assert.equal(attempt.code, GATE_F2); assert.equal(attempt.opens_on, "2026-07-12"); assert.match(attempt.reason, /REGX_1024_41F2_PRE_FILING_APP_GATE until 2026-07-12/);
  assert.equal(attempt.assertion.regx_days_delinquent, 121); assert.equal(attempt.assertion.gates.find((x) => x.code === GATE_120)!.result, "open", "refused by (f)(2), not by the 120-day gate"); assert.deepEqual(attempt.assertion.closed.map((x) => x.code), [GATE_F2]);
  const refused = w.ofType("foreclosure.gate.refused"); assert.equal(refused.length, 1); assert.equal(refused[0]!.payload.code, GATE_F2); assert.equal(refused[0]!.payload.command, "foreclosure.refer"); assert.equal(refused[0]!.payload.opens_on, "2026-07-12");
  assert.equal(w.escalations.opened.length, 1); assert.equal(w.escalations.opened[0]!.kind, "sev1"); assert.equal(w.escalations.opened[0]!.ownerRole, "compliance_sentinel");
  assert.deepEqual(w.ofType("foreclosure.referral.sent"), []); assert.deepEqual(w.store.list("attorney_referrals"), []);
  const f2Row = w.store.get("foreclosure_gate_evaluations", attempt.assertion.closed[0]!.evaluation_id)!.data; assert.equal(f2Row.result, "closed"); assert.equal(f2Row.step, "refer"); assert.equal((f2Row.inputs as { day_of_attempt: number }).day_of_attempt, 121);
  assert.ok(isRefusal(referLoan(w.d, { loan_id: w.loanId, firm_id: "firm-1", ...w.at(day(eu, 132)) })), "still closed the day before the window expires");
  const ok = referLoan(w.d, { loan_id: w.loanId, firm_id: "firm-1", ...w.at(day(eu, 133)) }); assert.ok(!isRefusal(ok)); assert.equal(ok.day, 133); assert.equal(ok.referred_on, "2026-07-12");
  assert.equal(w.ofType("foreclosure.referral.sent").length, 1);
  const w2 = world({ earliest_unpaid_due: eu, principal_residence: true, state: "TX" }, "L-131-F2");
  w2.store.put("lossmit_applications", "app-1", app({ appeal_denied_on: day(eu, 125), exit: "appeal_denied" }), OPS, iso(day(eu, 125)));
  const denied = referLoan(w2.d, { loan_id: w2.loanId, firm_id: "firm-1", ...w2.at(day(eu, 126)) }); assert.ok(!isRefusal(denied)); assert.equal(denied.day, 126);
});
test("13.1-T6: Given a due-on-sale violation recorded by `officer` with counsel memo at day 60, When `foreclosure.first_notice.authorize{ground=due_on_sale}`, Then allowed; When `{ground=default}`, Then refused.", () => {
  const base = { recorded_by_role: "officer", counsel_memo_document_id: "memo-1", today: D("2026-04-30"), earliest_unpaid_due: D("2026-03-01"), principal_residence: true };
  const dos = exceptionGround({ ...base, ground: "due_on_sale" }); assert.equal(dos.allowed, true); assert.equal(dos.state, "exception_open");
  const def = exceptionGround({ ...base, ground: "default" }); assert.equal(def.allowed, false); assert.equal(def.state, "closed"); assert.match(def.refusal!, /120_DAY_GATE/);
  assert.equal(exceptionGround({ ...base, ground: "due_on_sale", recorded_by_role: "ops_analyst" }).allowed, false);
  // Over the event store: the exception is the officer's `foreclosure_exceptions` record with counsel's memo (rule 4), read from the
  // store — `foreclosure.first_notice.authorize{ground=due_on_sale}` at day 60 (2026-04-30) is allowed and appends
  // `foreclosure.first_notice.authorized{ground}`; `{ground=default}` is refused by the 120-day gate (opens 2026-06-30).
  const eu = D("2026-03-01"); const day60 = D("2026-04-30");
  const w = world({ earliest_unpaid_due: eu, principal_residence: true, state: "TX" }, "L-131-DOS");
  const noRecord = authorizeFirstNotice(w.d, { loan_id: w.loanId, ground: "due_on_sale", ...w.at(day60) }); assert.ok(isRefusal(noRecord)); assert.equal(noRecord.code, GATE_120); assert.match(noRecord.reason, /requires an officer record with the counsel memo/);
  w.store.put("foreclosure_exceptions", "exc-1", { loan_id: w.loanId, kind: "due_on_sale", recorded_by_role: "officer", counsel_memo_document_id: "memo-1", recorded_on: day60 }, { kind: "human", id: "u-officer", role: "officer" }, iso(day60));
  const allowed = authorizeFirstNotice(w.d, { loan_id: w.loanId, ground: "due_on_sale", ...w.at(day60) }); assert.ok(!isRefusal(allowed)); assert.equal(allowed.ground, "due_on_sale"); assert.equal(allowed.on, day60);
  assert.equal(allowed.gates.find((x) => x.code === GATE_120)!.result, "exception_open"); assert.equal(allowed.gates.find((x) => x.code === GATE_FIRST_NOTICE_MADE)!.result, "open");
  const authorized = w.ofType("foreclosure.first_notice.authorized"); assert.equal(authorized.length, 1); assert.equal(authorized[0]!.payload.ground, "due_on_sale"); assert.equal(authorized[0]!.payload.regx_days_delinquent, 60);
  assert.equal(w.store.get("foreclosure_gate_evaluations", allowed.gates.find((x) => x.code === GATE_120)!.evaluation_id)!.data.reason_code, "exception_open:due_on_sale");
  const refused = authorizeFirstNotice(w.d, { loan_id: w.loanId, ground: "default", ...w.at(day60) }); assert.ok(isRefusal(refused)); assert.equal(refused.code, GATE_120); assert.equal(refused.opens_on, "2026-06-30"); assert.match(refused.reason, /60 days delinquent/);
  assert.equal(w.ofType("foreclosure.gate.refused")[1]!.payload.command, "foreclosure.first_notice.authorize{ground=default}"); assert.equal(w.ofType("foreclosure.first_notice.authorized").length, 1);
  const joinNoMemo = authorizeFirstNotice(w.d, { loan_id: w.loanId, ground: "join_lienholder", ...w.at(day60) }); assert.ok(isRefusal(joinNoMemo), "each ground needs its own officer record");
});
test('13.1-T7: Given NY property, day 121 reached but §1304 notice mailed only 50 days ago, Then referral allowed (policy) but `first_notice.authorize` refused by `STATE_PREFC_NOTICE_GATE:NY` until day 90 after mailing and §1306 filing evidenced.', () => {
  const r = nyFirstNoticeGate({ today: D("2026-06-30"), earliest_unpaid_due: D("2026-03-01"), s1304_mailed_on: D("2026-05-11"), s1306_filed: false });
  assert.equal(r.referral_allowed, true); assert.equal(r.first_notice_allowed, false); assert.equal(r.gate, "STATE_PREFC_NOTICE_GATE:NY"); assert.equal(r.opens_on, "2026-08-09"); assert.match(r.refusal!, /§1306 filing evidence/);
  assert.equal(nyFirstNoticeGate({ today: D("2026-08-09"), earliest_unpaid_due: D("2026-03-01"), s1304_mailed_on: D("2026-05-11"), s1306_filed: true }).first_notice_allowed, true);
  // Over the event store: NY loan, day 121 = 2026-06-30, §1304 mailed 2026-05-11 (50 days ago) — `foreclosure.refer` is allowed
  // (referral is gated by 13.1 policy only; the state gate scopes `first_notice`) but `foreclosure.first_notice.authorize` is refused
  // by STATE_PREFC_NOTICE_GATE:NY until 2026-08-09 (mailing + 90) with the §1306 DFS filing evidenced.
  const eu = D("2026-03-01"); const day121 = D("2026-06-30");
  const w = world({ earliest_unpaid_due: eu, principal_residence: true, state: "NY", s1304_mailed_on: "2026-05-11", s1306_filed: false }, "L-131-NY");
  const ref = referLoan(w.d, { loan_id: w.loanId, firm_id: "firm-ny", ...w.at(day121) }); assert.ok(!isRefusal(ref)); assert.equal(ref.day, 121); assert.equal(w.ofType("foreclosure.referral.sent").length, 1);
  const fn = authorizeFirstNotice(w.d, { loan_id: w.loanId, ...w.at(day121) }); assert.ok(isRefusal(fn)); assert.equal(fn.code, GATE_NY); assert.equal(fn.opens_on, "2026-08-09"); assert.match(fn.reason, /§1306 filing evidence/);
  assert.equal(fn.assertion.gates.find((x) => x.code === GATE_120)!.result, "open"); assert.deepEqual(fn.assertion.closed.map((x) => x.code), [GATE_NY]);
  assert.equal(w.ofType("foreclosure.gate.refused")[0]!.payload.code, GATE_NY); assert.equal(w.ofType("foreclosure.gate.refused")[0]!.payload.command, "foreclosure.first_notice.authorize{ground=default}"); assert.deepEqual(w.ofType("foreclosure.first_notice.authorized"), []);
  const day90 = D("2026-08-09");
  const noDfs = authorizeFirstNotice(w.d, { loan_id: w.loanId, ...w.at(day90) }); assert.ok(isRefusal(noDfs)); assert.equal(noDfs.code, GATE_NY, "90 days elapsed but the §1306 filing is not evidenced");
  w.store.put("loans", w.loanId, { s1306_filed: true }, OPS, iso(day90));
  assert.ok(isRefusal(authorizeFirstNotice(w.d, { loan_id: w.loanId, ...w.at(D("2026-08-08")) })), "day 89 after mailing");
  const ok = authorizeFirstNotice(w.d, { loan_id: w.loanId, ...w.at(day90) }); assert.ok(!isRefusal(ok)); assert.equal(ok.on, day90); assert.equal(ok.gates.find((x) => x.code === GATE_NY)!.result, "open");
  assert.equal(w.ofType("foreclosure.first_notice.authorized").length, 1);
});
test("13.1-T8: Given a referral attempt while the gate is closed, Then command refused, `foreclosure.gate.refused` written, sev-1 escalation, and no message leaves for the attorney network.", () => {
  const r = refusedReferral({ gate: "REGX_1024_41F1_120_DAY_GATE", opens_on: D("2026-06-30"), attempted_on: D("2026-06-01"), actor: "foreclosure-ops" });
  assert.equal(r.refused, true); assert.equal(r.event.type, "foreclosure.gate.refused"); assert.equal(r.escalation.severity, "sev1"); assert.equal(r.escalation.kind, "compliance_sentinel"); assert.equal(r.attorney_message_sent, false);
  // Over the event store: `foreclosure.refer` at day 92 (2026-06-01) on a principal residence due 2026-03-01 — refused by the
  // 120-day gate (opens 2026-06-30), `foreclosure.gate.refused{command, code}` with its evaluation row, the sev-1 Compliance
  // Sentinel escalation, and nothing for the attorney network: no `foreclosure.referral.sent`, no `attorney_referrals` row, no case.
  const w = world({ earliest_unpaid_due: D("2026-03-01"), principal_residence: true, state: "TX" }, "L-131-T8");
  w.sweep(D("2026-03-02")); assert.equal(w.timers.byCode(GATE_120)[0]!.status, "armed");
  const a = referLoan(w.d, { loan_id: w.loanId, firm_id: "firm-1", ...w.at(D("2026-06-01")) });
  assert.ok(isRefusal(a)); assert.equal(a.code, GATE_120); assert.equal(a.opens_on, "2026-06-30"); assert.equal(a.attorney_message_sent, false); assert.match(a.reason, /92 days delinquent; no referral\/first notice before day 121/);
  const ev = w.ofType("foreclosure.gate.refused"); assert.equal(ev.length, 1); assert.equal(ev[0]!.id, a.event_id); assert.equal(ev[0]!.payload.command, "foreclosure.refer"); assert.equal(ev[0]!.payload.code, GATE_120); assert.equal(ev[0]!.payload.step, "refer"); assert.equal(ev[0]!.payload.attempted_on, "2026-06-01"); assert.equal(ev[0]!.payload.opens_on, "2026-06-30");
  assert.deepEqual(ev[0]!.payload.evaluation_ids, a.assertion.gates.map((g) => g.evaluation_id)); assert.equal(w.store.get("foreclosure_gate_evaluations", a.assertion.closed[0]!.evaluation_id)!.data.result, "closed");
  const esc = w.escalations.opened; assert.equal(esc.length, 1); assert.equal(esc[0]!.id, a.escalation_id); assert.equal(esc[0]!.kind, "sev1"); assert.equal(esc[0]!.ownerRole, "compliance_sentinel"); assert.equal(esc[0]!.loanId, w.loanId); assert.equal(esc[0]!.payload.gate, GATE_120); assert.equal(esc[0]!.payload.command, "foreclosure.refer");
  assert.deepEqual(w.ofType("foreclosure.referral.sent"), []); assert.deepEqual(w.store.list("attorney_referrals"), []); assert.deepEqual(w.store.list("foreclosure_cases"), []);
  assert.equal(w.timers.byCode(GATE_120)[0]!.status, "armed", "the gate instance stays armed — a refusal never satisfies it");
});
test("13.1-T9: Given rule set flipped to `regx.lossmit.2024nprm` on an effective date, Then evaluations after that date reference the new gate codes and a diff report is produced.", () => {
  const before = ruleSetSwap({ effective_on: D("2027-01-01"), evaluation_on: D("2026-12-31") }); assert.equal(before.rule_set, "regx.lossmit.2013"); assert.ok(before.gate_codes.includes("REGX_1024_41F2_PRE_FILING_APP_GATE"));
  const after = ruleSetSwap({ effective_on: D("2027-01-01"), evaluation_on: D("2027-01-01") }); assert.equal(after.rule_set, "regx.lossmit.2024nprm"); assert.ok(after.gate_codes.includes("NPRM_REVIEW_CYCLE_GATE"));
  assert.deepEqual(after.diff, { added: ["NPRM_REVIEW_CYCLE_GATE", "NPRM_FEE_FREEZE"], removed: ["REGX_1024_41F2_PRE_FILING_APP_GATE"] });
  // Every evaluation row records its rule_set_version (edge cases: "evaluations record `rule_set_version`").
  const w = world({ earliest_unpaid_due: D("2026-03-01"), principal_residence: true, state: "TX" }, "L-131-RS");
  const a = assertGateOpen(w.d, { loan_id: w.loanId, step: "refer", ...w.at(D("2026-06-30")) });
  for (const g of a.gates) assert.match(String(w.store.get("foreclosure_gate_evaluations", g.evaluation_id)!.data.rule_set_version), /^regx\.lossmit\.2013/);
});
test('13.1-T10: Given a transfer-in with transferor first filing evidenced, Then no second "first notice" is authorized and the 7.1 statement flag is true from boarding.', () => {
  const r = transferredFirstFiling({ transferor_first_notice_filed_at: D("2026-05-20"), transferor_state_prefc_notice_sent: true, transferor_lpi_due: D("2026-01-01") });
  assert.equal(r.second_first_notice_allowed, false); assert.equal(r.statement_flag_from_boarding, true); assert.equal(r.resend_state_prefc_notice, false);
  // Over the event store: boarding 2026-07-01 carries the transferor's 2026-05-20 complaint as `foreclosure.first_notice.filed`
  // (with its evidence document, carried_from_transferor), counters seed from the transferor's LPI (never the transfer date), the
  // loan row's 1026.41(d)(8) flag is true from boarding, and `foreclosure.first_notice.authorize` is refused — there is no second "first notice".
  const w = world({ principal_residence: true, state: "FL" }, "L-131-XFER", iso(D("2026-07-01")));
  assert.throws(() => transferInForeclosureState(w.d, { loan_id: w.loanId, boarded_on: D("2026-07-01"), transferor: { first_notice_filed_at: D("2026-05-20"), state_prefc_notice_sent: true, lpi_due: D("2026-01-01") }, ...w.at(D("2026-07-01")) }), RangeError, "no evidence, no filing");
  const t = transferInForeclosureState(w.d, { loan_id: w.loanId, boarded_on: D("2026-07-01"), transferor: { first_notice_filed_at: D("2026-05-20"), first_notice_evidence_document_id: "doc-complaint", first_notice_kind: "complaint", state_prefc_notice_sent: true, lpi_due: D("2026-01-01") }, ...w.at(D("2026-07-01")) });
  assert.equal(t.second_first_notice_allowed, false); assert.equal(t.statement_flag_from_boarding, true); assert.deepEqual(t.events, ["foreclosure.first_notice.filed"]); assert.ok(t.case_id);
  const loan = w.store.get("loans", w.loanId)!.data; assert.equal(loan.first_notice_or_filing_made, true); assert.equal(loan.earliest_unpaid_due, "2026-01-01"); assert.equal(loan.fc_first_notice_filed_at, "2026-05-20");
  const filed = w.ofType("foreclosure.first_notice.filed"); assert.equal(filed.length, 1); assert.equal(filed[0]!.payload.carried_from_transferor, true); assert.equal(filed[0]!.payload.statement_flag_1026_41d8, true); assert.equal(filed[0]!.payload.filed_on, "2026-05-20"); assert.equal(filed[0]!.payload.evidence_document_id, "doc-complaint");
  const s = w.sweep(D("2026-07-02")); assert.equal(s.regx_days_delinquent, 182, "counters seed from the transferor's earliest unpaid due date"); assert.equal(s.state, "open");
  const fn = authorizeFirstNotice(w.d, { loan_id: w.loanId, ...w.at(D("2026-07-15")) }); assert.ok(isRefusal(fn)); assert.equal(fn.code, GATE_FIRST_NOTICE_MADE); assert.match(fn.reason, /already made on 2026-05-20 by the transferor/);
  assert.equal(fn.assertion.gates.find((x) => x.code === GATE_120)!.result, "open", "the 120-day gate is open — it is the earlier filing that bars a second one"); assert.deepEqual(w.ofType("foreclosure.first_notice.authorized"), []);
  const ref = assertGateOpen(w.d, { loan_id: w.loanId, step: "refer", ...w.at(D("2026-07-15")) }); assert.equal(ref.gates.some((x) => x.code === GATE_FIRST_NOTICE_MADE), false, "the no-second-first-notice rule scopes the first_notice step");
});

// ---- the BK_362_STAY_GATE row over the 14.x feed: armed by `bankruptcy.petition.filed`, satisfied only by the 13.1 projection's `foreclosure.gate.opened{code=BK_362_STAY_GATE}`.
test("13.1 BK_362_STAY_GATE: `bankruptcy.petition.filed` closes the gate and arms the timer; 14.x's stay end (dismissal/discharge without lien avoidance/relief) is validated and projected as `foreclosure.gate.opened{code=BK_362_STAY_GATE}`, which satisfies it — a discharge with lien avoidance or a mere extension never opens it", () => {
  const w = world({ earliest_unpaid_due: D("2026-01-01"), principal_residence: true, state: "TX" }, "L-131-BK", iso(D("2026-06-01"))); const off = wireForeclosureGateReactors_13_1(w.d);
  w.sweep(D("2026-06-01")); assert.equal(w.timers.byCode(GATE_120)[0]!.status, "satisfied", "day 151: the 120-day gate opened on the first sweep");
  const petition = w.events.append({ type: "bankruptcy.petition.filed", loanId: w.loanId, actor: OPS, payload: { chapter: "13", petition_date: "2026-06-01", case_number: "4:26-bk-1" } });
  const stay = w.timers.byCode(GATE_BK); assert.equal(stay.length, 1); assert.equal(stay[0]!.status, "armed"); assert.equal(stay[0]!.armedByEventId, petition.id); assert.equal(stay[0]!.dueAt, undefined, "a not-before gate has no due date");
  const closed = w.ofType("foreclosure.gate.closed"); assert.equal(closed.length, 1); assert.equal(closed[0]!.payload.code, GATE_BK); assert.equal(closed[0]!.payload.reason, "petition_filed"); assert.equal(closed[0]!.causationId, petition.id);
  const refusedRef = referLoan(w.d, { loan_id: w.loanId, firm_id: "firm-1", ...w.at(D("2026-06-02")) }); assert.ok(!isRefusal(refusedRef), "13.1's own gates are open at day 152 — the stay is asserted by the 14.x hold/evaluator on the bus, days keep counting");
  const ext = w.events.append({ type: "bankruptcy.stay.extended", loanId: w.loanId, actor: OPS, payload: { through: "2026-09-01" } }); assert.throws(() => bankruptcyStayEnded(w.d, { loan_id: w.loanId, event: ext, ...w.at(D("2026-06-03")) }), RangeError);
  const avoided = w.events.append({ type: "bankruptcy.stay.terminated", loanId: w.loanId, actor: OPS, payload: { reason: "discharge", treatment: "lien_avoidance" } });
  const rej = bankruptcyStayEnded(w.d, { loan_id: w.loanId, event: avoided, ...w.at(D("2026-06-03")) }); assert.equal(rej.opened, false); assert.match(rej.refusal!, /lien avoidance/); assert.equal(stay[0]!.status, "armed"); assert.deepEqual(w.ofType("foreclosure.gate.opened").filter((e) => e.payload.code === GATE_BK), []);
  const modified = w.events.append({ type: "bankruptcy.stay.terminated", loanId: w.loanId, actor: OPS, payload: { reason: "plan_modified" } }); assert.equal(bankruptcyStayEnded(w.d, { loan_id: w.loanId, event: modified, ...w.at(D("2026-06-03")) }).opened, false);
  const dismissed = w.events.append({ type: "bankruptcy.stay.terminated", loanId: w.loanId, actor: OPS, payload: { reason: "dismissal", statute: "11 U.S.C. §349" } });
  // the reactor wired above already projected the gate from this event; the projection is idempotent per source event
  const p = bankruptcyStayEnded(w.d, { loan_id: w.loanId, event: dismissed, ...w.at(D("2026-06-10")) }); assert.equal(p.opened, true); assert.equal(p.reason, "dismissal");
  const opened = w.ofType("foreclosure.gate.opened").filter((e) => e.payload.code === GATE_BK); assert.equal(opened.length, 1); assert.equal(opened[0]!.id, p.event_id); assert.equal(opened[0]!.payload.source_event_id, dismissed.id);
  assert.ok(eventMatches(REG.get(GATE_BK)!.satisfiedPattern!, opened[0]!)); assert.equal(stay[0]!.status, "satisfied"); assert.equal(stay[0]!.satisfiedByEventId, opened[0]!.id);
  const w2 = world({ earliest_unpaid_due: D("2026-01-01"), principal_residence: true, state: "TX" }, "L-131-BK2", iso(D("2026-06-01"))); wireForeclosureGateReactors_13_1(w2.d);
  w2.events.append({ type: "bankruptcy.petition.filed", loanId: w2.loanId, actor: OPS, payload: { chapter: "7" } });
  w2.events.append({ type: "bankruptcy.stay.relief_effective", loanId: w2.loanId, actor: OPS, payload: { foreclosure_blocked: true, entered_on: "2026-07-01" } }); assert.equal(w2.timers.byCode(GATE_BK)[0]!.status, "armed", "relief order not yet effective (Rule 4001(a)(3))");
  w2.events.append({ type: "bankruptcy.stay.relief_effective", loanId: w2.loanId, actor: OPS, payload: { foreclosure_blocked: false, entered_on: "2026-07-01" } }); assert.equal(w2.timers.byCode(GATE_BK)[0]!.status, "satisfied");
  assert.equal(w2.ofType("foreclosure.gate.opened").filter((e) => e.payload.code === GATE_BK)[0]!.payload.reason, "relief_from_stay");
  off();
});
