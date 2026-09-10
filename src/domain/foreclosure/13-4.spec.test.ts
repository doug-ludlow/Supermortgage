// 13.4 Prereferral review
// spec/sections/13-foreclosure/13-4-prereferral-review.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
//
// Each T-id runs its Given/When/Then through the process's own code paths: the rule calculators (./ops.ts,
// ./referral.ts), the event-emitting operations (./ops-13-4.ts) driving a TimerEngine loaded with the overridden
// registry (so the 13.4 timers are proven to arm on their trigger and to be satisfied by the events the process
// emits), and — where the T-id names a refusal on the command path — the 13.4 tools on the bus.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, addDays, endOfMonth } from "../../kernel/calendar/date.ts";
import { addBusinessDays, fannieEt } from "../../kernel/calendar/business.ts";
import { MemoryEventStore, FixedClock, type Actor } from "../../kernel/events/index.ts";
import { eventMatches } from "../../kernel/events/match.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { CommandBus, CommandRefused, type CommandSpec } from "../../app/commands.ts";
import { AgentRegistry, loadAgentsFile } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EVALUATORS } from "../../app/evaluators.ts";
import { EntityStore, toolCommand, type ToolRuntime, type ToolInput } from "../../app/tools.ts";
import { SECTION_13_TOOLS } from "../../app/tools/section13.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { FakeDmdc, FakePacer } from "../../infra/integrations/legal.ts";
import { offerWindowHold, nonPrLadder, disasterHold, scraHold, maLeadPaintItem, expeditedReview, modelItemGate, siiStatusItem, bankruptcyScrubItem, DISASTER_REQUEST_ELEMENTS } from "./ops.ts";
import { maCitationSearchCompleted } from "./ops-13-7.ts";
import { reviewWindow, reviewValid, reviewOutcome, referralEligible, type Gates } from "./referral.ts";
import { reviewDue, startReview, completeReview, reviewValidForReferral, prProhibitions, nonPrBrpItem, ingestWorkoutPlanPayment, submitDisasterFcRequest, recordDisasterFcResponse, disasterRequestElements, DISASTER_REQUEST_CONTENT, type ReviewDeps, type DisasterRequest } from "./ops-13-4.ts";

const AGENT: Actor = { kind: "agent", id: "foreclosure-ops" };
const OFFICER: Actor = { kind: "human", id: "u-officer", role: "officer" };
const EU = D("2026-03-01");   // D = earliest unpaid due date of every worked example (rule 1)
const NPR = reviewWindow(EU, false);   // June 14–29 (refer by June 29)
const PR = reviewWindow(EU, true);     // June 15–30 (refer no earlier than June 30)
const day = (n: number) => `${addDays(EU, n)}T15:00:00.000Z`;   // delinquency day n at 15:00Z (11:00 ET)
const GATES_OPEN: Gates = { regx_120: true, regx_prefiling: true, no_first_filing_41k2: true, fnma_121: true, bk_stay: false, scra: false, dmdc_age_days: 10, disaster_approval: true, litigation_hold: false, environmental_hold: false, mn_dual_track: false, title_hold: false, package_ready: true };

/** The process's own event store + timer engine (overridden registry, 13.4 rows only) + entity store; `at(iso)` moves the clock and hands back the ops deps. */
function engine(now: string) {
  const clock = new FixedClock(now); const events = new MemoryEventStore(clock); const store = new EntityStore();
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["13.4"] });
  const at = (iso: string): ReviewDeps => { clock.set(iso); return { events, store, actor: AGENT, now: iso }; };
  const timer = (code: string, nth = -1) => timers.byCode(code).at(nth);
  const types = (loanId: string) => events.byLoan(loanId).map((e) => e.type);
  return { clock, events, store, timers, at, timer, types };
}
/** The 13.4 tools on the bus (src/app/tools/section13.ts) with the same engine underneath. */
function bus(ports: ToolRuntime["ports"] = {}, now = "2026-06-20T15:00:00.000Z", loanId = "L-134") {
  const clock = new FixedClock(now); const events = new MemoryEventStore(clock); const decisions: DecisionInput[] = [];
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["13.4"] });
  const ctx: UowContext & { decisions: DecisionInput[]; clock: FixedClock } = { loanId, events, ledger: new MemoryLedger(), timers, clock, decide: (d) => { decisions.push({ loanId, ...d }); }, decisions };
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(events, clock), services: {}, ports };
  // The §13 tools only, bound the way src/app/tools/index.ts bindTools does (this test never needs the other sections' tool files).
  const agents = new AgentRegistry(); const escalates = new Map(loadAgentsFile().processes.map((p) => [p.process, p.escalates_to] as const)); const cmds = new Map<string, CommandSpec<ToolInput, unknown>>();
  for (const d of SECTION_13_TOOLS) { const cmd = toolCommand(d, rt, escalates.get(d.process) ?? []); agents.registerTool(d.agent, cmd.name); cmds.set(`${d.process} ${d.name}`, cmd); }
  const cb = new CommandBus(agents);
  const run = (process: string, name: string, actor: Actor, input: Record<string, unknown>) => cb.execute(cmds.get(`${process} ${name}`)!, actor, input, ctx, {});
  const put = (kind: string, id: string, data: Record<string, unknown>) => rt.store.put(kind, id, data, OFFICER, clock.now());
  const timer = (code: string, nth = -1) => timers.byCode(code).at(nth);
  return { ctx, rt, run, put, timer, events, types: () => events.all().map((e) => e.type) };
}
const refused = (code: string) => (e: unknown) => e instanceof CommandRefused && e.code === code;
type Wrapped<T> = { result: T; item: { item_code: string; result: string; evaluator: string; evidence_ids: string[] } | null; review: { id: string; outcome: string | null; valid_for_referral: boolean | null; referral: { ok: boolean; refusal: string | null } | null; pending_human: string[] } };
const fullRequest = (): DisasterRequest => ({ recommendation: "initiate foreclosure proceedings", disaster_event_date: D("2026-05-20"), repair_status: "roof repairs 40% complete; contractor engaged", insurance_claim: { claim_date: D("2026-05-28"), status: "open — adjuster inspected", proceeds_cents: 1250000n }, borrower_engagement: { summary: "QRPC achieved 2026-06-02; borrower intends to sell", qrpc_achieved: true, borrower_intent: "sell" } });

test("13.4-T1: Given D = Mar. 1, 2026 and a non-principal residence, Then the review window is June 14–29; a review completed June 10 is rejected for referral; one completed June 20 with all passes yields `refer`.", () => {
  // Rule 1 arithmetic: non-PR D+105 … D+120 (refer by); PR D+106 … D+121 (refer no earlier than).
  assert.deepEqual([NPR.opens, NPR.referral_on, NPR.rule], ["2026-06-14", "2026-06-29", "refer_by"]);
  assert.deepEqual([PR.opens, PR.referral_on, PR.rule], ["2026-06-15", "2026-06-30", "refer_no_earlier_than"]);
  assert.equal(reviewValid(D("2026-06-10"), NPR), false, "a review completed before the window is not valid for referral"); assert.equal(reviewValid(D("2026-06-20"), NPR), true);
  assert.equal(reviewOutcome({ items_all_pass: true, pr_prohibition_failing: false, disaster_impacted: false, nonpr_complete_brp: false, scra_active: false, bk_hit: false }), "refer");
  assert.equal(reviewOutcome({ items_all_pass: false, pr_prohibition_failing: false, disaster_impacted: false, nonpr_complete_brp: false, scra_active: false, bk_hit: false }), "hold_lossmit");
  assert.equal(referralEligible("refer", GATES_OPEN).ok, true); assert.deepEqual(referralEligible("refer", { ...GATES_OPEN, dmdc_age_days: 31 }).blocked_by, ["SCRA_DMDC_STALE_30"]);
  // June 10 (day 101): the scheduler does not fire, FNMA_E3201_PREREFERRAL_REVIEW_15 is not armed, and a completion is recorded but rejected for referral.
  const h = engine("2026-06-10T15:00:00.000Z"); const loan = "L-134-T1";
  const early = reviewDue(h.at("2026-06-10T15:00:00.000Z"), { loan_id: loan, earliest_unpaid_due: EU, principal_residence: false });
  assert.equal(early.in_window, false); assert.equal(early.event, null); assert.equal(h.timer("FNMA_E3201_PREREFERRAL_REVIEW_15"), undefined);
  const june10 = completeReview(h.at("2026-06-10T16:00:00.000Z"), { loan_id: loan, review_id: "prr-t1-early", outcome: "refer", items: 33, window: NPR });
  assert.equal(june10.valid_for_referral, false); assert.equal(june10.referral.ok, false); assert.match(june10.referral.refusal!, /completed 2026-06-10 is before the window opens 2026-06-14 .*refer.* by 2026-06-29/);
  assert.equal(june10.event.payload.valid_for_referral, false); assert.equal(june10.event.payload.completed_on, "2026-06-10");
  assert.deepEqual(reviewValidForReferral(D("2026-06-10"), NPR, NPR.referral_on).valid, false);
  // June 20 (day 111): review start fires `prereferral.review.due{referral_required_on=2026-06-29}` → the window timer arms [June 14, June 29]; the preconditions are read from the 11.x dates.
  const started = startReview(h.at("2026-06-20T15:00:00.000Z"), { loan_id: loan, review_id: "prr-t1", principal_residence: false, earliest_unpaid_due: EU, breach_letter_expires_on: D("2026-05-15"), solicitation_respond_by: D("2026-05-20"), latest_dmdc_certificate_date: D("2026-06-12") });
  assert.equal(started.in_window, true); assert.deepEqual(started.window, NPR); assert.deepEqual(started.preconditions, { breach_letter_expired: true, solicitation_deadline_expired: true, breach_letter_expires_on: D("2026-05-15"), solicitation_respond_by: D("2026-05-20") });
  assert.deepEqual(started.items.map((it) => [it.item_code, it.result]), [["BREACH_EXPIRED", "pass"], ["SOLICITATION_EXPIRED", "pass"]]);
  const due = h.events.byLoan(loan).find((e) => e.type === "prereferral.review.due")!;
  assert.equal(due.payload.referral_required_on, "2026-06-29"); assert.equal(due.payload.window_opens_on, "2026-06-14"); assert.equal(due.payload.day, 111);
  const win = h.timer("FNMA_E3201_PREREFERRAL_REVIEW_15")!;
  assert.equal(win.status, "armed"); assert.equal(win.anchorDate, "2026-06-29"); assert.equal(win.dueDate, "2026-06-29"); assert.equal(win.note, "window opens 2026-06-14"); assert.equal(win.armedByEventId, due.id);
  assert.equal(h.timer("FNMA_E3201_PRECONDITIONS_GATE")!.note, "evaluator:13.4.breachLetterAndSolicitationExpired");
  assert.equal(EVALUATORS["13.4.breachLetterAndSolicitationExpired"]!(started.event.payload).open, true);
  // the same day, all passes → refer, valid for referral; the completion satisfies the window timer on time.
  const june20 = completeReview(h.at("2026-06-20T18:00:00.000Z"), { loan_id: loan, review_id: "prr-t1", outcome: "refer", items: 33, window: NPR });
  assert.equal(june20.valid_for_referral, true); assert.deepEqual(june20.referral, { ok: true, refusal: null });
  assert.equal(win.status, "satisfied"); assert.equal(win.satisfiedByEventId, june20.event.id);
  assert.ok(!h.types(loan).includes("prereferral.hold.opened"), "refer opens no hold");
  // a second due firing on the same day is suppressed; a later day inside the window re-fires (inputs may have changed)
  assert.equal(reviewDue(h.at("2026-06-20T19:00:00.000Z"), { loan_id: loan, earliest_unpaid_due: EU, principal_residence: false }).event, null);
  assert.equal(reviewDue(h.at("2026-06-21T15:00:00.000Z"), { loan_id: loan, earliest_unpaid_due: EU, principal_residence: false, reason: "payment" })!.event!.payload.reason, "payment");
});

test("13.4-T2: Given a principal residence with an offer response window open until day 125, Then outcome `hold_lossmit`; on expiry without acceptance, re-review → `refer` (no delay beyond expiry per E-3.2-01).", () => {
  const expiry = addDays(EU, 125); assert.equal(expiry, "2026-07-04");
  assert.deepEqual(offerWindowHold({ window_ends_on: expiry, today: D("2026-07-01"), accepted: false }), { outcome: "hold_lossmit" });
  assert.deepEqual(offerWindowHold({ window_ends_on: expiry, today: D("2026-07-05"), accepted: false }), { outcome: "refer" });
  assert.deepEqual(offerWindowHold({ window_ends_on: expiry, today: D("2026-07-05"), accepted: true }), { outcome: "hold_performing" });
  // Day 122 (July 1): the third E-3.2-01 prohibition fails → hold_lossmit; the hold arms the daily re-review.
  const h = engine(day(122)); const loan = "L-134-T2";
  const open = prProhibitions({ today: D("2026-07-01"), principal_residence: true, offer_sent_on: D("2026-06-20"), offer_response_ends_on: expiry });
  assert.deepEqual(open.failing, ["PR_NO_OPEN_OFFER_WINDOW"]); assert.equal(open.outcome, "hold_lossmit"); assert.match(open.items.find((it) => it.item_code === "PR_NO_OPEN_OFFER_WINDOW")!.reason, /response period open until 2026-07-04/);
  assert.equal(reviewOutcome({ items_all_pass: true, pr_prohibition_failing: true, disaster_impacted: false, nonpr_complete_brp: false, scra_active: false, bk_hit: false }), "hold_lossmit");
  const held = completeReview(h.at(day(122)), { loan_id: loan, review_id: "prr-t2", outcome: "hold_lossmit", items: 33, window: PR });
  assert.equal(held.referral.ok, false); assert.equal(held.referral.refusal, "review outcome hold_lossmit — referral held");
  assert.equal(h.events.byLoan(loan).find((e) => e.type === "prereferral.hold.opened")!.payload.kind, "hold_lossmit");
  const daily = h.timer("SM_PREREFERRAL_RE_REVIEW_DAILY")!;
  assert.equal(daily.status, "armed"); assert.equal(daily.armedByEventId, held.event.id); assert.equal(daily.dueDate, "2026-07-02");
  // Day 126 (July 5): the response period expired without acceptance — the item passes and the re-review yields refer, valid for the referral that day; the daily re-review is satisfied.
  const expired = prProhibitions({ today: D("2026-07-05"), principal_residence: true, offer_sent_on: D("2026-06-20"), offer_response_ends_on: expiry });
  assert.deepEqual(expired.failing, []); assert.equal(expired.outcome, "clear"); assert.match(expired.items.find((it) => it.item_code === "PR_NO_OPEN_OFFER_WINDOW")!.reason, /expired 2026-07-04 without acceptance — no delay beyond expiry \(E-3\.2-01\)/);
  const refer = completeReview(h.at(day(126)), { loan_id: loan, review_id: "prr-t2", outcome: "refer", items: 33, window: PR, referral_on: D("2026-07-05") });
  assert.equal(refer.valid_for_referral, true); assert.equal(refer.referral.ok, true);
  assert.equal(daily.status, "satisfied"); assert.equal(daily.satisfiedByEventId, refer.event.id);
  // an acceptance being performed is the fourth prohibition; a non-principal residence records every PR item n_a (E-3.2-04 governs)
  assert.deepEqual(prProhibitions({ today: D("2026-07-05"), principal_residence: true, offer_accepted_on: D("2026-07-03"), performing: true }).failing, ["PR_NOT_PERFORMING_ON_ACCEPTED_OFFER"]);
  assert.ok(prProhibitions({ today: D("2026-07-01"), principal_residence: false, offer_response_ends_on: expiry }).items.every((it) => it.result === "n_a"));
});

test("13.4-T3: Given a complete BRP on day 119 for a non-principal residence, Then `postpone_e3204`; determination on day 140 (offer sent, 14-day window) → acceptance day 150 → first payment due Aug. 1 → referral held until Aug. 31 if unpaid; paid → held until breach.", () => {
  const brpOn = addDays(EU, 119), offerOn = addDays(EU, 140), acceptedOn = addDays(EU, 150), firstDue = D("2026-08-01");
  assert.deepEqual([brpOn, offerOn, acceptedOn, endOfMonth(firstDue)], ["2026-06-28", "2026-07-19", "2026-07-29", "2026-08-31"]);
  const a = nonPrLadder({ earliest_unpaid_due: EU, complete_brp_on: brpOn }); assert.equal(a.outcome, "postpone_e3204"); assert.equal(a.state, "brp_pending");
  const b = nonPrLadder({ earliest_unpaid_due: EU, complete_brp_on: brpOn, offer_sent_on: offerOn }); assert.equal(b.offer_expires_on, "2026-08-02"); assert.equal(b.state, "offer_window");
  const c = nonPrLadder({ earliest_unpaid_due: EU, complete_brp_on: brpOn, offer_sent_on: offerOn, accepted_on: acceptedOn, first_payment_due: firstDue }); assert.equal(c.held_until, "2026-08-31"); assert.equal(c.state, "awaiting_first_payment");
  const d = nonPrLadder({ earliest_unpaid_due: EU, complete_brp_on: brpOn, offer_sent_on: offerOn, accepted_on: acceptedOn, first_payment_due: firstDue, first_payment_received: true }); assert.equal(d.state, "performing_until_breach"); assert.equal(d.held_until, null);
  /** The ladder up to the acceptance, on the engine: each 12.x rung arms the next E-3.2-04 timer and is closed by the rung after it. */
  const ladder = (loan: string) => {
    const h = engine(day(119));
    // day 119: the complete BRP fails the NONPR_BRP item → postpone_e3204 (an inquiry never postpones); `lossmit.application.completed` arms the 30-day evaluation postponement to day 149.
    const item = nonPrBrpItem({ today: brpOn, principal_residence: false, earliest_unpaid_due: EU, complete_brp_received_on: brpOn });
    assert.equal(item.item.result, "fail"); assert.equal(item.ladder!.state, "brp_pending"); assert.match(item.item.reason, /postpone referral \(E-3\.2-04 ladder: brp_pending\)/);
    assert.equal(nonPrBrpItem({ today: brpOn, principal_residence: false, earliest_unpaid_due: EU, complete_brp_received_on: brpOn, inquiry_only: true }).item.result, "pass", "a borrower inquiry never postpones (E-3.2-04)");
    assert.equal(reviewOutcome({ items_all_pass: true, pr_prohibition_failing: false, disaster_impacted: false, nonpr_complete_brp: true, scra_active: false, bk_hit: false }), "postpone_e3204");
    const postponed = completeReview(h.at(day(119)), { loan_id: loan, review_id: `prr-${loan}`, outcome: "postpone_e3204", items: 33, window: NPR });
    assert.equal(postponed.referral.ok, false); assert.equal(h.events.byLoan(loan).find((e) => e.type === "prereferral.hold.opened")!.payload.kind, "postpone_e3204");
    h.events.append({ type: "lossmit.application.completed", loanId: loan, actor: AGENT, payload: { application_id: `app-${loan}`, status: "complete", received_date: brpOn, complete_date: brpOn, principal_residence: false } });
    const eval30 = h.timer("FNMA_E3204_NONPR_EVAL_30")!; assert.equal(eval30.status, "armed"); assert.equal(eval30.dueDate, addDays(brpOn, 30)); assert.equal(eval30.dueDate, "2026-07-28");
    // day 140: the determination closes the evaluation rung; the retention offer arms the 14-day response rung to Aug 2.
    h.at(day(140)); h.events.append({ type: "lossmit.determination.sent", loanId: loan, actor: AGENT, payload: { application_id: `app-${loan}`, decision: "offer", option: "repayment_plan", sent_on: offerOn } });
    assert.equal(eval30.status, "satisfied");
    h.events.append({ type: "lossmit.offer.sent", loanId: loan, actor: AGENT, payload: { kind: "offer", option: "repayment_plan", principal_residence: false, provided_at: offerOn, response_due: addDays(offerOn, 14) } });
    const offer14 = h.timer("FNMA_E3204_NONPR_OFFER_14")!; assert.equal(offer14.status, "armed"); assert.equal(offer14.anchorDate, offerOn); assert.equal(offer14.dueDate, "2026-08-02");
    assert.equal(nonPrBrpItem({ today: offerOn, principal_residence: false, earliest_unpaid_due: EU, complete_brp_received_on: brpOn, offer_sent_on: offerOn }).ladder!.held_until, "2026-08-02");
    // day 150: acceptance closes the offer rung; `lossmit.offer.accepted{first_payment_due_date=Aug 1}` arms the month-end rung to Aug 31.
    h.at(day(150)); h.events.append({ type: "lossmit.offer.responded", loanId: loan, actor: AGENT, payload: { offer_id: `off-${loan}`, option: "repayment_plan", response: "accepted", accepted_via: "written", responded_on: acceptedOn } });
    assert.equal(offer14.status, "satisfied");
    h.events.append({ type: "lossmit.offer.accepted", loanId: loan, actor: AGENT, payload: { offer_id: `off-${loan}`, option: "repayment_plan", plan_id: `plan-${loan}`, accepted_on: acceptedOn, first_payment_due_date: firstDue } });
    const eom = h.timer("FNMA_E3204_NONPR_FIRST_PAYMENT_EOM")!; assert.equal(eom.status, "armed"); assert.equal(eom.anchorDate, firstDue); assert.equal(eom.dueDate, "2026-08-31");
    const awaiting = nonPrBrpItem({ today: D("2026-08-15"), principal_residence: false, earliest_unpaid_due: EU, complete_brp_received_on: brpOn, offer_sent_on: offerOn, offer_accepted_on: acceptedOn, first_payment_due: firstDue });
    assert.equal(awaiting.item.result, "fail"); assert.equal(awaiting.ladder!.held_until, "2026-08-31");
    return { h, eom };
  };
  // unpaid: the month-end rung breaches after Aug 31 and referral resumes the next day
  const unpaid = ladder("L-134-T3a");
  assert.deepEqual(unpaid.h.timers.evaluate("2026-08-31T20:00:00.000Z").map((b) => b.def.code), [], "still held on Aug 31");
  assert.deepEqual(unpaid.h.timers.evaluate("2026-09-01T12:00:00.000Z").map((b) => b.def.code), ["FNMA_E3204_NONPR_FIRST_PAYMENT_EOM"]); assert.equal(unpaid.eom.status, "breached");
  const resumed = nonPrBrpItem({ today: D("2026-09-01"), principal_residence: false, earliest_unpaid_due: EU, complete_brp_received_on: D("2026-06-28"), offer_sent_on: offerOn, offer_accepted_on: acceptedOn, first_payment_due: firstDue });
  assert.equal(resumed.item.result, "pass"); assert.match(resumed.item.reason, /first payment not received by 2026-08-31 — referral resumes the next day/);
  // paid: the posted first plan payment (`workout_plan.payment.received{first=true}`) satisfies the rung → held until breach
  const paid = ladder("L-134-T3b");
  const pay = ingestWorkoutPlanPayment(paid.h.at("2026-08-20T15:00:00.000Z"), { loan_id: "L-134-T3b", plan_id: "plan-L-134-T3b", due_on: firstDue, received_on: D("2026-08-20"), amount_cents: 185000n, first_payment_due: firstDue });
  assert.equal(pay.first, true); assert.equal(pay.on_time, true); assert.equal(pay.event.payload.amount_cents, "185000"); assert.equal(pay.event.payload.sequence, 1);
  assert.equal(paid.eom.status, "satisfied"); assert.equal(paid.eom.satisfiedByEventId, pay.event.id);
  const performing = nonPrBrpItem({ today: D("2026-09-01"), principal_residence: false, earliest_unpaid_due: EU, complete_brp_received_on: D("2026-06-28"), offer_sent_on: offerOn, offer_accepted_on: acceptedOn, first_payment_due: firstDue, first_payment_received: true });
  assert.equal(performing.item.result, "fail"); assert.equal(performing.ladder!.state, "performing_until_breach"); assert.equal(performing.ladder!.held_until, null);
  assert.match(nonPrBrpItem({ today: D("2026-10-05"), principal_residence: false, earliest_unpaid_due: EU, complete_brp_received_on: D("2026-06-28"), first_payment_received: true, breached: true }).item.reason, /breached the accepted workout — referral resumes/);
  assert.equal(ingestWorkoutPlanPayment(paid.h.at("2026-09-15T15:00:00.000Z"), { loan_id: "L-134-T3b", plan_id: "plan-L-134-T3b", due_on: D("2026-09-01"), received_on: D("2026-09-15"), amount_cents: 185000n }).first, false);
  assert.throws(() => ingestWorkoutPlanPayment(paid.h.at("2026-09-15T15:00:00.000Z"), { loan_id: "L-134-T3b", plan_id: "plan-L-134-T3b", due_on: D("2026-09-01"), received_on: D("2026-09-15"), amount_cents: 0n }), RangeError);
});

test("13.4-T4: Given a FEMA IA declaration and inspection damage, Then outcome `hold_disaster_approval`, request emailed within 5 days with all five content elements, gate closed until approval; approval → `refer`.", () => {
  const req = Object.fromEntries(DISASTER_REQUEST_ELEMENTS.map((e) => [e, "provided"]));
  const held = disasterHold({ fema_ia: true, inspection_damage: true, review_completed_on: D("2026-06-25"), request: req });
  assert.equal(held.outcome, "hold_disaster_approval"); assert.equal(held.request_due, "2026-06-30"); assert.equal(held.elements_present.length, 5); assert.deepEqual(held.elements_missing, []); assert.equal(held.gate, "closed");
  assert.equal(disasterHold({ fema_ia: true, inspection_damage: true, review_completed_on: D("2026-06-25"), request: { recommendation: "foreclose" } }).elements_missing.length, 4);
  assert.equal(disasterHold({ fema_ia: true, inspection_damage: false, review_completed_on: D("2026-06-25"), request: req }).gate, "open", "a declared county without damage evidence is not impacted (rule 4)");
  const approvedCalc = disasterHold({ fema_ia: true, inspection_damage: true, review_completed_on: D("2026-06-25"), request: req, fnma_approval_id: "FNMA-D-1" }); assert.equal(approvedCalc.outcome, "refer"); assert.equal(approvedCalc.gate, "open");
  assert.deepEqual([...DISASTER_REQUEST_CONTENT], [...DISASTER_REQUEST_ELEMENTS]);
  // June 25 (day 116, inside the window): the review completes hold_disaster_approval — complete for the 5-day clock (rule 2): FNMA_D1301_DISASTER_FC_REQUEST_5 arms, due June 30.
  const h = engine("2026-06-25T15:00:00.000Z"); const loan = "L-134-T4";
  assert.equal(reviewOutcome({ items_all_pass: true, pr_prohibition_failing: false, disaster_impacted: true, nonpr_complete_brp: false, scra_active: false, bk_hit: false }), "hold_disaster_approval");
  const done = completeReview(h.at("2026-06-25T15:00:00.000Z"), { loan_id: loan, review_id: "prr-t4", outcome: "hold_disaster_approval", items: 33, window: NPR });
  assert.equal(done.event.payload.disaster_impacted, true); assert.equal(done.event.payload.completed_on, "2026-06-25"); assert.equal(done.referral.ok, false);
  h.store.put("prereferral_reviews", "prr-t4", { loan_id: loan, outcome: "hold_disaster_approval", completed_at: "2026-06-25T15:00:00.000Z" }, AGENT, "2026-06-25T15:00:00.000Z");
  const five = h.timer("FNMA_D1301_DISASTER_FC_REQUEST_5")!;
  assert.equal(five.status, "armed"); assert.equal(five.anchorDate, "2026-06-25"); assert.equal(five.dueDate, "2026-06-30"); assert.equal(five.armedByEventId, done.event.id);
  assert.equal(h.timer("SM_PREREFERRAL_RE_REVIEW_DAILY")!.status, "armed");
  // an incomplete request is refused, naming the missing elements; nothing is submitted
  assert.throws(() => submitDisasterFcRequest(h.at("2026-06-26T15:00:00.000Z"), { loan_id: loan, review_id: "prr-t4", kind: "initiate", request: { recommendation: "initiate foreclosure proceedings" } }), (e: unknown) => e instanceof RangeError && /missing disaster_event_date, repair_status, insurance_claim, borrower_engagement/.test(e.message));
  assert.deepEqual(disasterRequestElements({ recommendation: "x", disaster_event_date: "2026-05-20", repair_status: "y", insurance_claim: { status: "open", proceeds_cents: "0" }, borrower_engagement: { summary: "s", qrpc_achieved: true, borrower_intent: "sell" } }).missing, ["insurance_claim"], "the claim element needs its date, status and proceeds");
  assert.equal(five.status, "armed"); assert.equal(h.store.list("disaster_fc_approval_requests").length, 0);
  // June 26 (a Friday, inside the 5 days): the complete request is emailed to hazard_loss@ — the timer is satisfied on time and the 10-BD follow-up arms (July 3 is the observed Independence Day holiday → due July 13).
  const sent = submitDisasterFcRequest(h.at("2026-06-26T15:00:00.000Z"), { loan_id: loan, request_id: "dfr-t4", review_id: "prr-t4", kind: "initiate", request: fullRequest(), message_id: "<msg-1@supermortgage>" });
  assert.equal(sent.request_id, "dfr-t4"); assert.equal(sent.due_by, "2026-06-30"); assert.equal(sent.row.channel, "email:hazard_loss"); assert.equal(sent.row.to, "hazard_loss@fanniemae.com"); assert.equal(sent.row.fnma_response, "pending"); assert.equal(sent.row.kind, "initiate");
  assert.equal((sent.row.payload as { insurance_claim: { proceeds_cents: string } }).insurance_claim.proceeds_cents, "1250000");
  assert.deepEqual(sent.event.payload.elements, [...DISASTER_REQUEST_CONTENT]); assert.equal(sent.event.payload.submitted_at, "2026-06-26T15:00:00.000Z");
  assert.equal(five.status, "satisfied"); assert.equal(five.satisfiedByEventId, sent.event.id);
  const followup = h.timer("SM_DISASTER_FC_RESPONSE_FOLLOWUP_10BD")!;
  assert.equal(followup.status, "armed"); assert.equal(followup.anchorDate, "2026-06-26"); assert.equal(followup.dueDate, "2026-07-13"); assert.equal(followup.dueDate, addBusinessDays(D("2026-06-26"), 10, fannieEt));
  assert.ok(h.types(loan).includes("disaster_fc_approval.requested"));
  // gate closed until approval: the 13.1 gate evaluator reads the approval id; nothing on file → closed
  assert.equal(EVALUATORS["13.1.disasterApprovalOnFile"]!({ disaster_impacted: true, fnma_disaster_fc_approval_id: null }).open, false);
  // July 6: Fannie Mae approves — the follow-up is satisfied, `fnma.disaster_fc.approved` opens the 13.1 gate, the hold is released, and the re-review yields refer.
  const ok = recordDisasterFcResponse(h.at("2026-07-06T15:00:00.000Z"), { loan_id: loan, request_id: "dfr-t4", response: "approved", response_document_id: "doc-fnma-reply-1" });
  assert.equal(ok.row.fnma_response, "approved"); assert.equal(ok.approval_id, "fnma-dfa-dfr-t4"); assert.equal(ok.hold_released, true); assert.equal(ok.escalate, null);
  assert.equal(followup.status, "satisfied"); assert.equal(followup.satisfiedByEventId, ok.event.id);
  const approvedEvent = h.events.byLoan(loan).find((e) => e.type === "fnma.disaster_fc.approved")!;
  assert.equal(approvedEvent.payload.fnma_disaster_fc_approval_id, "fnma-dfa-dfr-t4"); assert.equal(approvedEvent.causationId, ok.event.id);
  assert.equal(h.events.byLoan(loan).find((e) => e.type === "prereferral.hold.released")!.payload.kind, "hold_disaster_approval");
  assert.ok(h.types(loan).includes("disaster_fc_approval.approved"));
  assert.equal(EVALUATORS["13.1.disasterApprovalOnFile"]!({ disaster_impacted: true, fnma_disaster_fc_approval_id: ok.approval_id }).open, true);
  const refer = completeReview(h.at("2026-07-06T16:00:00.000Z"), { loan_id: loan, review_id: "prr-t4", outcome: "refer", items: 33, window: NPR, referral_on: D("2026-07-06") });
  assert.equal(refer.referral.ok, true); assert.equal(h.timer("SM_PREREFERRAL_RE_REVIEW_DAILY", 0)!.status, "satisfied");
  assert.equal(disasterHold({ fema_ia: true, inspection_damage: true, review_completed_on: D("2026-07-06"), request: fullRequest() as unknown as Record<string, unknown>, fnma_approval_id: ok.approval_id }).outcome, "refer");
  // a denial is recorded, releases nothing and is the officer's call to contest (13.4 escalations)
  submitDisasterFcRequest(h.at("2026-07-07T15:00:00.000Z"), { loan_id: loan, request_id: "dfr-t4b", review_id: "prr-t4", kind: "continue", request: fullRequest() });
  const denied = recordDisasterFcResponse(h.at("2026-07-10T15:00:00.000Z"), { loan_id: loan, request_id: "dfr-t4b", response: "denied" });
  assert.equal(denied.hold_released, false); assert.equal(denied.approval_id, null); assert.equal(denied.escalate, "officer");
  assert.throws(() => recordDisasterFcResponse(h.at("2026-07-10T15:00:00.000Z"), { loan_id: loan, request_id: "dfr-none", response: "approved" }), RangeError);
});

test("13.4-T5: Given DMDC shows active duty, Then `hold_scra`; the referral command is refused even if all other items pass.", async () => {
  const r = scraHold({ active_duty: true, items_all_pass: true, gates: GATES_OPEN }); assert.equal(r.outcome, "hold_scra"); assert.equal(r.referral.ok, false); assert.ok(r.referral.blocked_by.length > 0);
  assert.equal(scraHold({ active_duty: false, items_all_pass: true, gates: GATES_OPEN }).referral.ok, true);
  assert.equal(reviewOutcome({ items_all_pass: true, pr_prohibition_failing: false, disaster_impacted: false, nonpr_complete_brp: false, scra_active: true, bk_hit: false }), "hold_scra");
  // On the bus: the review start arms SM_DMDC_VERIFY_PRE_REFERRAL_30; the DMDC single-record lookup returns Y — the certificate verifies the status (the gate's satisfaction) but the item fails and the completed review is hold_scra; the referral step is refused by the SCRA gate.
  const dmdc = new FakeDmdc(); dmdc.activeDuty.set("borrower|6789", { start: "2026-03-15", end: null });   // FakeDmdc keys on last name + SSN last 4
  const b = bus({ dmdc }); b.put("loans", "L-134", { id: "L-134", principal_residence: false, earliest_unpaid_due_date: "2026-03-01", state: "TX", regx_days_delinquent: 111, fnma_days_delinquent: 111 });
  await b.run("13.4", "notices.search", AGENT, { op: "start_review", loan_id: "L-134", review_id: "prr-t5", latest_dmdc_certificate_date: "2026-06-12" });
  const gate = b.timer("SM_DMDC_VERIFY_PRE_REFERRAL_30")!; assert.equal(gate.status, "armed"); assert.equal(gate.anchorDate, "2026-06-12"); assert.equal(gate.note, "evaluator:13.4.dmdcCertificateFresh");
  const y = (await b.run("13.4", "dmdc.verify", AGENT, { loan_id: "L-134", review_id: "prr-t5", last_name: "Borrower", first_name: "A", ssn: "123456789" })).output as Wrapped<{ status: string; outcome: string; certificate_id: string }>;
  assert.equal(y.result.status, "Y"); assert.equal(y.result.outcome, "hold_scra"); assert.equal(y.item!.item_code, "SCRA_DMDC"); assert.equal(y.item!.result, "fail"); assert.deepEqual(y.item!.evidence_ids, [y.result.certificate_id]);
  const verified = b.events.all().find((e) => e.type === "scra.status.verified")!; assert.equal(verified.payload.on_active_duty, "Y"); assert.equal(gate.status, "satisfied"); assert.equal(gate.satisfiedByEventId, verified.id);
  assert.equal(EVALUATORS["13.4.dmdcCertificateFresh"]!({ dmdc_certificate_age_days: 8 }).open, true); assert.equal(EVALUATORS["13.4.dmdcCertificateFresh"]!({ dmdc_certificate_age_days: 31 }).open, false);
  const done = (await b.run("13.4", "inspection.get", AGENT, { id: "insp-1", loan_id: "L-134", review_id: "prr-t5", item: "OCCUPANCY_VERIFIED", item_result: "pass", evidence_document_id: "insp-doc", complete_review: true })).output as Wrapped<unknown>;
  assert.equal(done.review.outcome, "hold_scra"); assert.equal(done.review.referral!.ok, false); assert.equal(done.review.referral!.refusal, "review outcome hold_scra — referral held");
  const gates = (await b.run("13.1", "foreclosure.gates.evaluate", AGENT, { loan_id: "L-134", step: "refer" })).output as { open: boolean; blocked_by: string[] };
  assert.equal(gates.open, false); assert.ok(gates.blocked_by.includes("SCRA_3953C_FC_PROTECTION_GATE"));
  // No DMDC adapter: the review holds (hold_scra + dmdc_batch portal task) — never a fabricated "not on active duty", never a verification event that would satisfy the DMDC gates (13.4 Integrations: "never refer without a current certificate").
  const unwired = bus({}); unwired.put("loans", "L-134", { id: "L-134", principal_residence: false, earliest_unpaid_due_date: "2026-03-01", state: "TX" });
  await unwired.run("13.4", "notices.search", AGENT, { op: "start_review", loan_id: "L-134", review_id: "prr-t5u", latest_dmdc_certificate_date: "2026-06-12" });
  const none = (await unwired.run("13.4", "dmdc.verify", AGENT, { loan_id: "L-134", review_id: "prr-t5u", last_name: "Borrower", first_name: "A", ssn: "123456789" })).output as Wrapped<{ status: string; outcome: string; certificate_id: null; verified: boolean }>;
  assert.equal(none.result.status, "unavailable"); assert.equal(none.result.outcome, "hold_scra"); assert.equal(none.result.certificate_id, null); assert.equal(none.result.verified, false); assert.equal(none.item!.result, "fail");
  assert.ok(!unwired.types().includes("dmdc.verification.completed")); assert.ok(!unwired.types().includes("scra.status.verified")); assert.equal(unwired.timer("SM_DMDC_VERIFY_PRE_REFERRAL_30")!.status, "armed", "the DMDC gate stays unsatisfied");
  assert.equal(unwired.rt.store.list("scra_verifications").length, 0); assert.ok(unwired.rt.escalations.opened.some((e) => e.kind === "human_portal_task" && e.payload.kind === "dmdc_batch"));
});

test("13.4-T6: Given MA property without the lead-paint citation search, Then refused; with search evidence, passes.", async () => {
  const r = maLeadPaintItem({ state: "MA" }); assert.equal(r.required, true); assert.equal(r.passed, false); assert.match(r.refusal!, /lead-paint citation search/);
  assert.equal(maLeadPaintItem({ state: "MA", citation_search_document_id: "doc-lp" }).passed, true); assert.equal(maLeadPaintItem({ state: "TX" }).required, false);
  // The MA review start arms FNMA_F108_MA_LEAD_PAINT_SEARCH_GATE (a TX start does not); completing without the search is refused on the bus; the 13.7 citation-search completion satisfies the gate and the review passes with the search as evidence.
  const b = bus(); b.put("loans", "L-134", { id: "L-134", principal_residence: false, earliest_unpaid_due_date: "2026-03-01", state: "MA" });
  await b.run("13.4", "notices.search", AGENT, { op: "start_review", loan_id: "L-134", review_id: "prr-t6" });
  const gate = b.timer("FNMA_F108_MA_LEAD_PAINT_SEARCH_GATE")!; assert.equal(gate.status, "armed"); assert.equal(gate.note, "evaluator:13.4.maCitationSearchCompleted");
  await assert.rejects(b.run("13.4", "inspection.get", AGENT, { id: "insp-1", loan_id: "L-134", review_id: "prr-t6", state: "MA", item: "OCCUPANCY_VERIFIED", item_result: "pass", evidence_document_id: "insp-doc", complete_review: true }), refused("MA_LEAD_PAINT"));
  assert.equal(b.rt.store.get("prereferral_reviews", "prr-t6")!.data.outcome, null, "refused before any outcome is recorded");
  const search = maCitationSearchCompleted({ loan_id: "L-134", state: "MA", search_document_id: "doc-lp", completed_on: D("2026-06-18"), citations_found: 0 });
  const ev = b.events.append({ type: search.events[0]!.type, loanId: "L-134", actor: OFFICER, payload: search.events[0]!.payload });
  assert.equal(gate.status, "satisfied"); assert.equal(gate.satisfiedByEventId, ev.id); assert.equal(EVALUATORS["13.4.maCitationSearchCompleted"]!(ev.payload).open, true); assert.equal(EVALUATORS["13.4.maCitationSearchCompleted"]!({}).open, false);
  const done = (await b.run("13.4", "inspection.get", AGENT, { id: "insp-1", loan_id: "L-134", review_id: "prr-t6", state: "MA", item: "OCCUPANCY_VERIFIED", item_result: "pass", evidence_document_id: "insp-doc", citation_search_document_id: "doc-lp", complete_review: true })).output as Wrapped<unknown>;
  assert.equal(done.review.outcome, "refer"); assert.equal(done.review.valid_for_referral, true);
  const tx = bus(); tx.put("loans", "L-134", { id: "L-134", principal_residence: false, earliest_unpaid_due_date: "2026-03-01", state: "TX" });
  await tx.run("13.4", "notices.search", AGENT, { op: "start_review", loan_id: "L-134", review_id: "prr-t6-tx" }); assert.equal(tx.timer("FNMA_F108_MA_LEAD_PAINT_SEARCH_GATE"), undefined);
});

test("13.4-T7: Given an abandoned property (two vacant inspections, utilities off) on a non-principal residence at day 70, Then expedited outcome permitted at breach-letter expiry; on a principal residence the Reg X gate still blocks until day 121.", () => {
  const npr = expeditedReview({ vacant_inspections: 2, utilities_off: true, principal_residence: false, breach_letter_expired: true, day: 70 }); assert.equal(npr.expedite_condition, true); assert.equal(npr.outcome, "refer_expedited"); assert.equal(npr.regx_blocks_until_day, null);
  const pr = expeditedReview({ vacant_inspections: 2, utilities_off: true, principal_residence: true, breach_letter_expired: true, day: 70 }); assert.equal(pr.outcome, "hold_lossmit"); assert.equal(pr.regx_blocks_until_day, 121);
  assert.equal(expeditedReview({ vacant_inspections: 2, utilities_off: true, principal_residence: true, breach_letter_expired: true, day: 121 }).outcome, "refer_expedited");
  assert.notEqual(expeditedReview({ vacant_inspections: 1, utilities_off: true, principal_residence: false, breach_letter_expired: true, day: 70 }).outcome, "refer_expedited", "one vacant inspection does not evidence abandonment");
  assert.notEqual(expeditedReview({ vacant_inspections: 2, utilities_off: true, principal_residence: false, breach_letter_expired: false, day: 70 }).outcome, "refer_expedited", "the breach letter must have expired");
  // The expedited completion is a referral outcome on the engine (day 70 = May 10 on a non-PR: no window constraint applies before the review window is fixed) and satisfies the recurring re-review like refer does.
  const h = engine(day(70)); const loan = "L-134-T7";
  const hold = completeReview(h.at(day(69)), { loan_id: loan, review_id: "prr-t7", outcome: "hold_lossmit", items: 33, window: null });
  assert.equal(hold.referral.ok, false); const daily = h.timer("SM_PREREFERRAL_RE_REVIEW_DAILY")!; assert.equal(daily.status, "armed");
  const exp = completeReview(h.at(day(70)), { loan_id: loan, review_id: "prr-t7", outcome: "refer_expedited", items: 33, window: null });
  assert.deepEqual(exp.referral, { ok: true, refusal: null }); assert.equal(exp.valid_for_referral, null); assert.equal(daily.status, "satisfied");
  // on a principal residence the Reg X 120-day gate (13.1) and the E-1.2-02 day-121 gate still refuse the referral step before day 121, whatever the review concluded
  assert.deepEqual(referralEligible("refer", { ...GATES_OPEN, regx_120: false, fnma_121: false }), { ok: false, blocked_by: ["regx_120", "fnma_121"] });
  assert.equal(referralEligible("refer", GATES_OPEN).ok, true);
});

test("13.4-T8: Given a model-evaluated occupancy item with confidence 0.7, Then `human_agent` verification task; review cannot complete until resolved.", async () => {
  const r = modelItemGate({ item: "occupancy", confidence: 0.7, human_resolved: false }); assert.equal(r.verification_task!.kind, "human_agent"); assert.equal(r.item_status, "pending_human"); assert.equal(r.review_can_complete, false);
  assert.equal(modelItemGate({ item: "occupancy", confidence: 0.7, human_resolved: true }).review_can_complete, true); assert.equal(modelItemGate({ item: "occupancy", confidence: 0.9, human_resolved: false }).review_can_complete, true);
  assert.equal(modelItemGate({ item: "occupancy", confidence: 0.85, human_resolved: false }).review_can_complete, true, "the threshold is < 0.85");
  // On the bus: the model's 0.7 occupancy item is recorded pending_human with the human_agent task; completion is refused until the human_agent's own entry resolves it.
  const b = bus(); b.put("loans", "L-134", { id: "L-134", principal_residence: false, earliest_unpaid_due_date: "2026-03-01", state: "TX" });
  const low = (await b.run("13.4", "inspection.get", AGENT, { id: "insp-1", loan_id: "L-134", review_id: "prr-t8", item: "OCCUPANCY_VERIFIED", item_result: "pass", evidence_document_id: "insp-doc", confidence: 0.7 })).output as Wrapped<unknown>;
  assert.equal(low.item!.result, "pending_human"); assert.equal(low.item!.evaluator, "model"); assert.deepEqual(low.review.pending_human, ["OCCUPANCY_VERIFIED"]);
  const task = b.rt.escalations.opened.find((e) => e.kind === "human_agent")!; assert.equal(task.payload.item, "OCCUPANCY_VERIFIED"); assert.equal(task.payload.confidence, 0.7);
  await assert.rejects(b.run("13.4", "inspection.get", AGENT, { id: "insp-1", loan_id: "L-134", review_id: "prr-t8", complete_review: true }), /OCCUPANCY_VERIFIED awaits human_agent verification/);
  assert.ok(!b.types().includes("prereferral.review.completed"));
  const human = (await b.run("13.4", "inspection.get", { kind: "human", id: "u-specialist", role: "human_agent" }, { id: "insp-1", loan_id: "L-134", review_id: "prr-t8", item: "OCCUPANCY_VERIFIED", item_result: "pass", evidence_document_id: "insp-doc" })).output as Wrapped<unknown>;
  assert.equal(human.item!.evaluator, "human"); assert.deepEqual(human.review.pending_human, []);
  const done = (await b.run("13.4", "inspection.get", AGENT, { id: "insp-1", loan_id: "L-134", review_id: "prr-t8", complete_review: true })).output as Wrapped<unknown>;
  assert.equal(done.review.outcome, "refer"); assert.ok(b.types().includes("prereferral.review.completed"));
});

test("13.4-T9: Given a pending successor-in-interest request, Then `SII_STATUS` fails and the review holds.", async () => {
  assert.deepEqual(siiStatusItem({ pending_sii_request: true }), { item: "SII_STATUS", passed: false, outcome: "hold_sii" });
  assert.deepEqual(siiStatusItem({ pending_sii_request: false }), { item: "SII_STATUS", passed: true, outcome: "pass" });
  // On the bus: a failed SII_STATUS item (recorded from the 4.4 pending request) holds the completed review — no referral, the hold event and the daily re-review.
  const b = bus(); b.put("loans", "L-134", { id: "L-134", principal_residence: false, earliest_unpaid_due_date: "2026-03-01", state: "TX" });
  const sii = siiStatusItem({ pending_sii_request: true });
  const done = (await b.run("13.4", "inspection.get", AGENT, { id: "insp-1", loan_id: "L-134", review_id: "prr-t9", item: sii.item, item_result: sii.passed ? "pass" : "fail", complete_review: true })).output as Wrapped<unknown>;
  assert.equal(done.item!.item_code, "SII_STATUS"); assert.equal(done.item!.result, "fail"); assert.equal(done.review.outcome, "hold_lossmit"); assert.equal(done.review.referral!.ok, false);
  assert.equal(b.events.all().find((e) => e.type === "prereferral.hold.opened")!.payload.kind, "hold_lossmit"); assert.equal(b.timer("SM_PREREFERRAL_RE_REVIEW_DAILY")!.status, "armed");
});

test("13.4-T10: Given a bankruptcy hit in the scrub, Then `hold_bankruptcy` and 14.x case opened.", async () => {
  assert.deepEqual(bankruptcyScrubItem({ pacer_hit: true, case_number: "26-10001" }), { outcome: "hold_bankruptcy", open_bk_case: { section: "14.x", case_number: "26-10001" } });
  assert.deepEqual(bankruptcyScrubItem({ pacer_hit: false }), { outcome: "pass", open_bk_case: null });
  assert.equal(reviewOutcome({ items_all_pass: true, pr_prohibition_failing: false, disaster_impacted: false, nonpr_complete_brp: false, scra_active: false, bk_hit: true }), "hold_bankruptcy");
  // On the bus: the PACER adapter's hit fails BK_SCRUB, opens the bk_stay hold and hands the petition to 14.x; the completed review is hold_bankruptcy.
  const pacer = new FakePacer(); pacer.parties.push({ caseNumber: "26-10001", court: "txnb", chapter: 13, lastName: "Borrower", firstName: "A", ssn4: "1234", dateFiled: "2026-05-01", status: "open" });
  const b = bus({ pacer }); b.put("loans", "L-134", { id: "L-134", principal_residence: false, earliest_unpaid_due_date: "2026-03-01", state: "TX" });
  const hit = (await b.run("13.4", "bk.scrub", AGENT, { loan_id: "L-134", review_id: "prr-t10", last_name: "Borrower", ssn4: "1234" })).output as Wrapped<{ scrubbed: boolean; outcome: string; open_bk_case: { section: string; case_number: string }; hold_id: string }>;
  assert.equal(hit.result.outcome, "hold_bankruptcy"); assert.deepEqual(hit.result.open_bk_case, { section: "14.x", case_number: "26-10001" }); assert.equal(hit.item!.result, "fail");
  assert.equal(b.rt.store.get("foreclosure_holds", hit.result.hold_id)!.data.kind, "bk_stay");
  const petition = b.events.all().find((e) => e.type === "bankruptcy.petition.filed")!; assert.equal(petition.payload.case_number, "26-10001"); assert.equal(petition.payload.source, "pacer_scrub");
  const done = (await b.run("13.4", "inspection.get", AGENT, { id: "insp-1", loan_id: "L-134", review_id: "prr-t10", item: "OCCUPANCY_VERIFIED", item_result: "pass", evidence_document_id: "insp-doc", complete_review: true })).output as Wrapped<unknown>;
  assert.equal(done.review.outcome, "hold_bankruptcy"); assert.equal(done.review.referral!.ok, false);
  assert.equal(b.timer("SM_PREREFERRAL_RE_REVIEW_DAILY")!.status, "armed");
  assert.ok(eventMatches(loadOverriddenRegistry().get("SM_PREREFERRAL_RE_REVIEW_DAILY")!.triggerPattern!, b.events.all().find((e) => e.type === "prereferral.review.completed")!), "the hold_bankruptcy completion is the daily re-review's trigger");
});
