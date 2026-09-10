// 1.7 Loss-mit in-flight transfer handling
// spec/sections/01-boarding-servicing-transfer-in/1-7-loss-mit-in-flight-transfer-handling.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { MemoryEventStore, FixedClock, SYSTEM, type Actor } from "../../kernel/events/index.ts";
import { eventMatches } from "../../kernel/events/match.ts";
import { loadRegistry, TimerEngine } from "../../kernel/timers/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { evaluateGate, assertGate, GateClosed } from "../../app/evaluators.ts";
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, toolCommand, type ToolRuntime } from "../../app/tools.ts";
import { TOOLS_1_7 } from "../../app/tools/section1-7.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { NoticeService } from "../../notices/service.ts";
import { FakePrintMail, FakeEdelivery } from "../../infra/integrations/delivery.ts";
import { BoardingService } from "../boarding/service.ts";
import { stagedLoan, batchContext, FakePositions, history } from "../boarding/fixtures.ts";
import { applyForeclosureTimerOverrides } from "../foreclosure/timers.ts";
import { applySatisfiedOverrides_13_1 } from "../foreclosure/timers-13-1.ts";
import { referralEligible, type Gates } from "../foreclosure/referral.ts";
import { applyTransferTimerOverrides } from "./timers.ts";
import { applySatisfiedOverrides_1_7 } from "./timers-1-7.ts";
import { deemedReceived, transfereeAckDue, transfereeEvaluationDue, transfereeAppealDue, honorTransferorOffer, forbearanceCarryover, firstFilingGate } from "./lossmit-inflight.ts";
import { runCarryoverChecks, borrowerRequestAllowed, denialSendGate, reissueTimersForRuleSet, verifyCarryover, requestFromTransferor, appealReceived, assignAppealReviewer, honorTransferorOfferCase, CARRYOVER_CHECKS, type TransferorLossmitFile } from "./inbound.ts";
import { inflightBoardingFacts, openInheritedCase, seedDelinquencyCounters, verifyBatchCarryover, smduCaseAccessChecked, closeAppealWindow, expireTransferorOffer, foreclosureReferralGate, type InheritedLossmitFile } from "./ops-1-7.ts";
const REVIEWER = { kind: "human" as const, id: "u-rev", role: "lossmit_reviewer" };
const AGENT: Actor = { kind: "agent", id: "lossmit-underwriter" };
const T = D("2026-10-01");
function registry() { const r = loadRegistry(); applyTransferTimerOverrides(r); applySatisfiedOverrides_1_7(r); applyForeclosureTimerOverrides(r); applySatisfiedOverrides_13_1(r); return r; }
function harness(nowIso: string, processes: readonly string[] = ["1.7"]) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock);
  const reg = registry();
  return { clock, events, timers: new TimerEngine(reg, events, { processes: [...processes] }), registry: reg };
}
/** The real boarding path: a validated loan with the transferor's loss-mit file boards on the transfer date and `BoardingService.board` emits `loan.boarded` with the 1.7 facts. */
function boardInherited(file: InheritedLossmitFile, o: { application_status?: string; received_on?: string; delinquent?: boolean; processes?: readonly string[] } = {}) {
  const h = harness("2026-10-01T14:00:00.000Z", o.processes ?? ["1.7"]);
  const ext = new FakePositions();
  const svc = new BoardingService({ events: h.events, ledger: new MemoryLedger(), ext, clock: h.clock, clearingAccountId: "CUST-CLEARING" });
  svc.openBatch(batchContext({ transfer_date: T }));
  const pi = stagedLoan().pi_cents!, esc = stagedLoan().escrow_payment_cents;
  const hist = o.delinquent ? history(D("2026-06-01"), 5, pi + esc, 2) : null;                  // Aug 1, Sep 1, Oct 1 unpaid → 61 days delinquent at T
  const loan = stagedLoan({ lossmit: { in_process: true, application_status: o.application_status ?? "incomplete", received_on: D(o.received_on ?? "2026-09-29"), inherited_file: file }, ...(hist ? { installments: hist.installments, payments: hist.payments } : {}) });
  ext.agree(loan);
  const [bl] = svc.stage("B1", [loan]); svc.validate("B1");
  assert.equal(bl!.status, "validated", `validation: ${bl!.validations.filter((v) => v.result === "fail").map((v) => v.code).join(",")}`);
  assert.equal(svc.board("B1", { finalTapeReconciled: true }).boarded.length, 1);
  const boarded = h.events.ofType("loan.boarded").at(-1)!;
  return { ...h, svc, boarded, loanId: boarded.loanId!, payload: boarded.payload as Record<string, unknown> };
}
/** The 1.7 tools on the bus (src/app/tools/section1-7.ts) over a unit of work. */
function bus(nowIso: string, loanId: string, events?: MemoryEventStore) {
  const clock = new FixedClock(nowIso); const ev = events ?? new MemoryEventStore(clock);
  const agents = new AgentRegistry(); const cb = new CommandBus(agents);
  const noticeReg = buildRegistry(); publishAuthored(noticeReg);
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(ev, clock), services: {}, ports: {}, notices: new NoticeService({ registry: noticeReg, events: ev, clock, printMail: new FakePrintMail(), edelivery: new FakeEdelivery() }) };
  const decisions: unknown[] = [];
  const uow = { loanId, events: ev, ledger: new MemoryLedger(), timers: new TimerEngine(registry(), ev, { processes: ["1.7"] }), clock, decide: (d: unknown) => { decisions.push(d); } };
  const cmd = (name: string) => { const def = TOOLS_1_7.find((t) => t.name === name); if (!def) throw new RangeError(`no 1.7 tool ${name}`); return toolCommand(def, rt, ["attorney", "fnma_portal_operator", "human_agent", "lossmit_reviewer", "officer"]); };
  return { clock, events: ev, rt, uow, decisions, run: (name: string, input: Record<string, unknown>, actor: Actor = AGENT, now?: string) => cb.execute(cmd(name), actor, input, uow, now ? { now } : {}) };
}

test("1.7-T1: Given an application received by the transferor Sept. 29, 2026 with no ack and transfer date Oct. 1, then `REGX_1024_41K2_TRANSFEREE_ACK_10` is due Oct. 16, 2026; an ack sent Oct. 19 → breach.", () => {
  assert.equal(transfereeAckDue(D("2026-10-01"), true), "2026-10-16");        // 10 federal BD: Oct 2, 5–9, 13–16 (Columbus Day Oct 12 excluded)
  assert.equal(deemedReceived(D("2026-09-29"), true, D("2026-10-01")), "2026-09-29");
  // The real emitter: BoardingService.board spreads inflightBoardingFacts onto `loan.boarded` — the transferor's 5-business-day ack period (Sept 29 → Oct 6) is unexpired at T and no ack was sent.
  const b = boardInherited({ application_present: true, application_received_on: D("2026-09-29"), completeness: "incomplete", ack_sent_on: null });
  assert.equal(b.payload.lossmit_ack_unexpired, true); assert.equal(b.payload.lossmit_ack_sent, false); assert.equal(b.payload.deemed_received_at, "2026-09-29"); assert.equal(b.payload.prior_1024_41_subject, true);
  const t = b.timers.byCode("REGX_1024_41K2_TRANSFEREE_ACK_10"); assert.equal(t.length, 1); assert.equal(t[0]!.dueDate, "2026-10-16"); assert.equal(t[0]!.anchorDate, "2026-10-01");
  const ack = (at: string) => b.timers.evaluate(at).filter((x) => x.def.code === "REGX_1024_41K2_TRANSFEREE_ACK_10");   // SM_SMDU_CASE_ACCESS_T0 (due T-0) is the other open clock on the case
  assert.equal(ack("2026-10-16T20:00:00.000Z").length, 0);
  const breach = ack("2026-10-19T14:00:00.000Z")[0]!;
  assert.equal(t[0]!.status, "breached"); assert.equal(breach.severity, 1); assert.ok(breach.escalateTo.includes("lossmit_reviewer"));
  b.events.append({ type: "notice.sent", loanId: b.loanId, actor: AGENT, payload: { template: "NTC_REGX_41B2_ACK_INCOMPLETE", sent_at: "2026-10-19" } });
  assert.equal(t[0]!.status, "satisfied_late");
  // comment 41(k)(1)(i)-3: a notice the transferor sent is not re-sent — no clock when the transferor's ack copy is on file.
  const sent = boardInherited({ application_present: true, application_received_on: D("2026-09-29"), completeness: "incomplete", ack_sent_on: D("2026-09-30"), ack_copy_document_id: "doc-ack", reasonable_date: D("2026-10-30") });
  assert.equal(sent.payload.lossmit_ack_sent, true); assert.equal(sent.timers.byCode("REGX_1024_41K2_TRANSFEREE_ACK_10").length, 0);
  // Edge case: the transferor's ack period expired before transfer (received Sept 18 → due Sept 25) — no (k)(2) ack duty, evaluation continues.
  const expired = inflightBoardingFacts({ in_process: true, inherited_file: { application_received_on: D("2026-09-18"), completeness: "incomplete", ack_sent_on: null } }, T);
  assert.equal(expired.lossmit_ack_unexpired, false); assert.equal(expired.lossmit_application_open, true);
});
test("1.7-T2: Given a complete application pending at transfer (received Sept. 20), then `REGX_1024_41K3_COMPLETE_APP_EVAL_30` is due Oct. 31, 2026 regardless of the transferor's original Oct. 20 deadline.", () => {
  assert.equal(transfereeEvaluationDue(D("2026-10-01")), "2026-10-31");
  const b = boardInherited({ application_present: true, application_received_on: D("2026-09-20"), completeness: "complete", ack_sent_on: D("2026-09-22"), ack_copy_document_id: "doc-ack" }, { application_status: "complete", received_on: "2026-09-20" });
  assert.equal(b.payload.completeness_status, "complete"); assert.equal(b.payload.complete_at, "2026-09-20");
  const t = b.timers.byCode("REGX_1024_41K3_COMPLETE_APP_EVAL_30"); assert.equal(t.length, 1); assert.equal(t[0]!.dueDate, "2026-10-31"); assert.equal(t[0]!.anchorDate, "2026-10-01");
  assert.equal(b.timers.evaluate("2026-10-21T14:00:00.000Z").filter((x) => x.def.code === "REGX_1024_41K3_COMPLETE_APP_EVAL_30").length, 0, "the transferor's Oct 20 deadline does not breach the transferee clock");
  b.events.append({ type: "notice.sent", loanId: b.loanId, actor: AGENT, payload: { template: "NTC_REGX_41C1_OFFER" } });
  assert.equal(t[0]!.status, "satisfied");
  assert.equal(b.timers.evaluate("2026-11-01T14:00:00.000Z").filter((x) => x.def.code === "REGX_1024_41K3_COMPLETE_APP_EVAL_30").length, 0, "a satisfied clock does not breach on day 31");
  // an undetermined copy of the same case breaches on day 31 from the transfer date (Nov 1), sev 1
  const late = harness("2026-10-01T14:00:00.000Z");
  late.events.append({ type: "loan.boarded", loanId: "L-27", actor: SYSTEM, payload: { transfer_date: "2026-10-01", ...inflightBoardingFacts({ in_process: true, inherited_file: { application_received_on: D("2026-09-20"), completeness: "complete", ack_sent_on: D("2026-09-22"), ack_copy_document_id: "doc-ack" } }, T) } });
  const k3 = late.timers.evaluate("2026-11-01T14:00:00.000Z").filter((x) => x.def.code === "REGX_1024_41K3_COMPLETE_APP_EVAL_30"); assert.equal(k3.length, 1); assert.equal(k3[0]!.severity, 1);
  assert.equal(b.timers.byCode("REGX_1024_41K2_NO_FIRST_FILING_GATE").length, 0, "a complete application has no incomplete-application reasonable date");
});
test("1.7-T3: Given an appeal filed Oct. 5 against a transferor denial, then the appeal determination is due Nov. 4, 2026 and the reviewer differs from any Supermortgage evaluator on the case.", () => {
  assert.equal(transfereeAppealDue(D("2026-10-01"), D("2026-10-05")), "2026-11-04");
  // Boarding: the transferor denied a Flex Mod Sept 24 (appeal window to Oct 8) — REGX_1024_41H_APPEAL_WINDOW_14 arms on the denial date; the application is not "open".
  const b = boardInherited({ application_present: true, application_received_on: D("2026-09-01"), completeness: "complete", ack_sent_on: D("2026-09-03"), ack_copy_document_id: "doc-ack", determination: { kind: "denial", sent_on: D("2026-09-24"), notice_document_id: "doc-denial", appeal_window_end: D("2026-10-08") } }, { application_status: "denied" });
  assert.equal(b.payload.appeal_window_unexpired, true); assert.equal(b.payload.transferor_denial_sent_on, "2026-09-24"); assert.equal(b.payload.lossmit_application_open, false);
  const w = b.timers.byCode("REGX_1024_41H_APPEAL_WINDOW_14"); assert.equal(w.length, 1); assert.equal(w[0]!.anchorDate, "2026-09-24"); assert.equal(w[0]!.dueDate, "2026-10-08");
  assert.throws(() => closeAppealWindow(b.events, { case_id: "C-3", loan_id: b.loanId, transfer_date: T, appeal_window_end: D("2026-10-08") }, { kind: "expired", today: D("2026-10-05") }), /cannot be closed as expired/);
  b.clock.set("2026-10-05T14:00:00.000Z");
  const r = closeAppealWindow(b.events, { case_id: "C-3", loan_id: b.loanId, transfer_date: T, appeal_window_end: D("2026-10-08") }, { kind: "appeal_received", received_on: D("2026-10-05"), received_by: "transferee" });
  assert.equal(r.outcome, "appeal_received"); assert.equal(w[0]!.status, "satisfied");
  assert.equal(r.appeal!.determination_due, "2026-11-04"); assert.equal(r.appeal!.k4_anchor_date, "2026-10-05");
  const t = b.timers.byCode("REGX_1024_41K4_APPEAL_DETERMINATION_30"); assert.equal(t.length, 1); assert.equal(t[0]!.dueDate, "2026-11-04");
  const reviewer = assignAppealReviewer([{ id: "u-eval", role: "evaluator" }, { id: "lossmit-underwriter", role: "agent" }], [{ id: "u-eval", role: "lossmit_reviewer" }, { id: "u-rev", role: "lossmit_reviewer" }]);
  assert.equal(reviewer.reviewer_id, "u-rev"); assert.ok(reviewer.excluded.includes("u-eval"));
  assert.throws(() => assignAppealReviewer([{ id: "u-rev", role: "evaluator" }], [{ id: "u-rev", role: "lossmit_reviewer" }]), /independent of the case's evaluators/);
  assert.equal(evaluateGate("12.3.reviewerIndependent", { reviewer_id: "u-rev", evaluator_id: "u-eval", reviewer_run_id: "r2", evaluator_run_id: "r1" }).open, true);
  b.events.append({ type: "notice.sent", loanId: b.loanId, actor: { kind: "human", id: "u-rev", role: "lossmit_reviewer" }, payload: { template: "NTC_REGX_41H4_APPEAL_DENIED", reviewer_id: "u-rev" } });
  assert.equal(t[0]!.status, "satisfied");
  // an appeal pending at transfer that the transferor received Sept 20 anchors on the transfer date (the later of the two) — armed at case creation
  const h = harness("2026-10-01T14:00:00.000Z");
  const pending = openInheritedCase(h.events, { case_id: "C-4", loan_id: "L-4", batch_id: "B1", transfer_date: T, lossmit: { in_process: true, inherited_file: { application_received_on: D("2026-09-01"), determination: { kind: "denial", sent_on: D("2026-09-10"), notice_document_id: "d", appeal_window_end: D("2026-09-24") }, appeal_pending: true, appeal: { received_on: D("2026-09-20"), received_by: "transferor" } } } });
  assert.equal(pending.status, "inherited_pending"); assert.equal(pending.appeal!.determination_due, "2026-10-31"); assert.equal(pending.event.payload.origin, "transferor");
  assert.equal(h.timers.byCode("REGX_1024_41K4_APPEAL_DETERMINATION_30")[0]!.dueDate, "2026-10-31");
  // a denial whose appeal window expired before transfer with no appeal is fully resolved — not pending (comment 41(k)(1)(i)-1)
  assert.equal(openInheritedCase(h.events, { case_id: "C-5", loan_id: "L-5", batch_id: "B1", transfer_date: T, lossmit: { in_process: true, inherited_file: { application_received_on: D("2026-08-01"), determination: { kind: "denial", sent_on: D("2026-09-10"), notice_document_id: "d", appeal_window_end: D("2026-09-24") } } } }).status, "not_pending");
  // a late appeal is untimely under (h)(2), not a window closure
  assert.throws(() => closeAppealWindow(h.events, { case_id: "C-5", loan_id: "L-5", transfer_date: T, appeal_window_end: D("2026-09-24") }, { kind: "appeal_received", received_on: D("2026-10-02"), received_by: "transferor" }), /untimely/);
});
test("1.7-T4: Given a transferor offer expiring Oct. 9 accepted by the borrower to the transferor Oct. 7, then Supermortgage honors it and the case reaches `plan_active` without re-underwriting.", async () => {
  assert.equal(honorTransferorOffer(D("2026-10-07"), D("2026-10-09")), "honor_no_reunderwrite"); assert.equal(honorTransferorOffer(D("2026-10-10"), D("2026-10-09")), "expired");
  const offer = { option: "Flex Modification trial period plan", offered_at: D("2026-09-25"), acceptance_deadline: D("2026-10-09"), terms: { payment_cents: 199_480n, rate_pct: "5.875", term_months: 480 } };
  const r = honorTransferorOfferCase({ case_id: "C-4", status: "offer_pending_acceptance", offer }, { accepted_on: D("2026-10-07"), received_by: "transferor" });
  assert.deepEqual([r.status, r.transitions, r.re_underwritten, r.honored, r.terms], ["plan_active", ["accepted", "plan_active"], false, true, offer.terms]);
  assert.equal(honorTransferorOfferCase({ case_id: "C-4", status: "offer_pending_acceptance", offer }, { accepted_on: D("2026-10-10"), received_by: "transferee" }).status, "expired");
  // REGX_1024_41K5_OFFER_ACCEPTANCE_BALANCE arms from the real boarding path on the original acceptance deadline; the borrower keeps the unexpired balance to Oct 9.
  const b = boardInherited({ application_present: true, application_received_on: D("2026-09-01"), completeness: "complete", ack_sent_on: D("2026-09-03"), ack_copy_document_id: "doc-ack", determination: { kind: "offer", sent_on: D("2026-09-25"), notice_document_id: "doc-offer" }, offer, borrower_response: "none" }, { application_status: "offered" });
  assert.equal(b.payload.lossmit_offer_pending, true); assert.equal(b.payload.acceptance_deadline, "2026-10-09");
  const t = b.timers.byCode("REGX_1024_41K5_OFFER_ACCEPTANCE_BALANCE"); assert.equal(t.length, 1); assert.equal(t[0]!.dueDate, "2026-10-09");
  // the case may not be closed as expired before Oct 9 (no breach; not_before for closure)
  assert.throws(() => expireTransferorOffer(b.events, { case_id: "C-4", loan_id: b.loanId, option: offer.option, acceptance_deadline: offer.acceptance_deadline }, D("2026-10-07")), /cannot be closed as expired/);
  assert.equal(t[0]!.status, "armed");
  // the acceptance the transferor received Oct 7 is honored through the bus tool on the original terms → lossmit.offer.closed{accepted} satisfies the clock
  const k = bus("2026-10-07T14:00:00.000Z", b.loanId, b.events); b.clock.set("2026-10-07T14:00:00.000Z");
  const out = (await k.run("honorTransferorOffer", { case_id: "C-4", loan_id: b.loanId, accepted_on: "2026-10-07", accept_by: "2026-10-09", received_by: "transferor", offer })).output as { status: string; re_underwritten: boolean; terms: { payment_cents: bigint } };
  assert.equal(out.status, "plan_active"); assert.equal(out.re_underwritten, false); assert.equal(out.terms.payment_cents, 199_480n);
  assert.equal(t[0]!.status, "satisfied");
  await assert.rejects(k.run("honorTransferorOffer", { case_id: "C-4", accepted_on: "2026-10-07", accept_by: "2026-10-09", offer, re_underwrite: true }), (e: unknown) => e instanceof CommandRefused && e.code === "NO_REUNDERWRITE");
  // unaccepted: the expiry sweep closes it only after Oct 9
  const h = harness("2026-10-01T14:00:00.000Z");
  h.events.append({ type: "loan.boarded", loanId: "L-4x", actor: SYSTEM, payload: { transfer_date: "2026-10-01", ...inflightBoardingFacts({ in_process: true, inherited_file: { application_received_on: D("2026-09-01"), determination: { kind: "offer", sent_on: D("2026-09-25") }, offer } }, T) } });
  const t2 = h.timers.byCode("REGX_1024_41K5_OFFER_ACCEPTANCE_BALANCE"); assert.equal(t2.length, 1);
  h.clock.set("2026-10-10T14:00:00.000Z"); const ex = expireTransferorOffer(h.events, { case_id: "C-4x", loan_id: "L-4x", option: offer.option, acceptance_deadline: offer.acceptance_deadline }, D("2026-10-10"));
  assert.equal(ex.event.payload.outcome, "expired"); assert.ok(eventMatches(h.registry.get("REGX_1024_41K5_OFFER_ACCEPTANCE_BALANCE")!.satisfiedPattern!, ex.event)); assert.equal(t2[0]!.status, "satisfied", "no breach: the borrower's window ran out unexercised");
});
test("1.7-T5: Given an incomplete application with a transferor reasonable date of Oct. 24, then a `foreclosure.referral` command on Oct. 20 is refused by `REGX_1024_41K2_NO_FIRST_FILING_GATE` and allowed on Oct. 25.", async () => {
  const g = firstFilingGate(D("2026-10-24"), D("2026-10-20")); assert.equal(g.ok, false); assert.equal(g.allowed_from, "2026-10-25"); assert.equal(g.gate, "REGX_1024_41K2_NO_FIRST_FILING_GATE");
  assert.equal(firstFilingGate(D("2026-10-24"), D("2026-10-25")).ok, true); assert.equal(firstFilingGate(D("2026-10-24"), D("2026-10-24")).ok, false);
  assert.throws(() => assertGate("1.7.noFirstFilingBeforeReasonableDate", { today: "2026-10-20", reasonable_date: "2026-10-24" }), (e: unknown) => e instanceof GateClosed && e.ref === "1.7.noFirstFilingBeforeReasonableDate");
  assert.equal(evaluateGate("1.7.noFirstFilingBeforeReasonableDate", { today: "2026-10-25", reasonable_date: "2026-10-24" }).open, true);
  // Worked example: application received at 101 days delinquent Sept 24; transfer Oct 1; the transferor's ack gave reasonable date Oct 24 → day 120 falls Oct 13 but no first filing before Oct 25.
  const b = boardInherited({ application_present: true, application_received_on: D("2026-09-24"), completeness: "incomplete", ack_sent_on: D("2026-09-26"), ack_copy_document_id: "doc-ack", reasonable_date: D("2026-10-24") }, { received_on: "2026-09-24", delinquent: true, processes: ["1.7", "13.1"] });
  assert.equal(b.payload.lossmit_application_incomplete, true); assert.equal(b.payload.transferor_reasonable_date, "2026-10-24"); assert.equal(b.payload.regx_days_delinquent, 61);
  const t = b.timers.byCode("REGX_1024_41K2_NO_FIRST_FILING_GATE"); assert.equal(t.length, 1); assert.equal(t[0]!.note, "evaluator:1.7.noFirstFilingBeforeReasonableDate"); assert.equal(t[0]!.anchorDate, "2026-10-24");
  // REGX_1024_41F1_120_DAY_GATE is seeded from the transferor's dates: the boarded counter (earliest unpaid Aug 1) arms the 13.1 gate at its original anchor.
  const seed = seedDelinquencyCounters(b.events, b.boarded)!;
  assert.equal(seed.type, "delinquency.counters.updated"); assert.equal(seed.payload.entered_delinquency, true); assert.equal(seed.payload.earliest_unpaid_due_date, "2026-08-01"); assert.equal(seed.payload.seeded_at_boarding, true);
  const f1 = b.timers.byCode("REGX_1024_41F1_120_DAY_GATE"); assert.equal(f1.length, 1); assert.equal(f1[0]!.anchorDate, "2026-08-01");
  assert.equal(seedDelinquencyCounters(b.events, { ...b.boarded, payload: { ...b.boarded.payload, regx_days_delinquent: 0 } }), null, "a current loan seeds nothing");
  // The `foreclosure.referral` command through the bus: the gate fact is derived from the acknowledgment's reasonable date, never a caller flag.
  const k = bus("2026-10-20T14:00:00.000Z", b.loanId, b.events);
  const gate20 = foreclosureReferralGate(b.events, b.loanId, D("2026-10-20")); assert.deepEqual([gate20.no_first_filing_41k2, gate20.reasonable_date, gate20.allowed_from, gate20.source], [false, "2026-10-24", "2026-10-25", "transferor"]);
  const base: Omit<Gates, "no_first_filing_41k2"> = { regx_120: true, regx_prefiling: true, fnma_121: true, bk_stay: false, scra: false, dmdc_age_days: 3, disaster_approval: true, litigation_hold: false, environmental_hold: false, mn_dual_track: false, title_hold: false, package_ready: true };
  assert.deepEqual(referralEligible("refer", { ...base, no_first_filing_41k2: gate20.no_first_filing_41k2 }).blocked_by, ["no_first_filing_41k2"]);
  const before = b.events.all().length;
  await assert.rejects(k.run("setForeclosureHold", { op: "referral", loan_id: b.loanId, today: "2026-10-20" }), (e: unknown) => e instanceof CommandRefused && e.code === "REGX_1024_41K2_NO_FIRST_FILING_GATE" && /before 2026-10-25/.test(e.message));
  assert.deepEqual(b.events.all().slice(before).map((e) => e.type), ["command.refused"]);
  const ok = (await k.run("setForeclosureHold", { op: "referral", loan_id: b.loanId, today: "2026-10-25" }, AGENT, "2026-10-25T14:00:00.000Z")).output as { gates: { no_first_filing_41k2: boolean }; allowed_from: string };
  assert.equal(ok.gates.no_first_filing_41k2, true); assert.equal(ok.allowed_from, "2026-10-25");
  assert.equal(referralEligible("refer", { ...base, ...ok.gates }).ok, true);
  // Supermortgage's own incomplete-application ack (when it sends one) supplies the reasonable date thereafter.
  b.events.append({ type: "notice.sent", loanId: b.loanId, actor: AGENT, payload: { template: "NTC_REGX_41B2_ACK_INCOMPLETE", reasonable_date: "2026-11-02" } });
  assert.deepEqual([foreclosureReferralGate(b.events, b.loanId, D("2026-10-25")).no_first_filing_41k2, foreclosureReferralGate(b.events, b.loanId, D("2026-10-25")).source], [false, "supermortgage"]);
  // Hold instructions to counsel (default op) still write the hold row.
  assert.equal(((await k.run("setForeclosureHold", { loan_id: b.loanId, data: { kind: "lossmit_41k2", reason: "no first filing before 2026-10-25" } })).output as { kind: string }).kind, "lossmit_41k2");
});
test("1.7-T6: Given an application not previously subject to §1024.41, then `deemed_received_at` = Oct. 1 and the ack is due Oct. 8, 2026.", () => {
  assert.equal(deemedReceived(D("2026-09-29"), false, D("2026-10-01")), "2026-10-01");
  assert.equal(transfereeAckDue(D("2026-10-01"), false), "2026-10-08");       // 5 federal BD: Oct 2, 5, 6, 7, 8
  // Transferor exempt small servicer: the file says the application was not subject to §1024.41 there → deemed received on the transfer date.
  const b = boardInherited({ application_present: true, application_received_on: D("2026-09-29"), completeness: "incomplete", ack_sent_on: null, subject_to_1024_41_at_transferor: false });
  assert.equal(b.payload.lossmit_application_open, true); assert.equal(b.payload.prior_1024_41_subject, false); assert.equal(b.payload.deemed_received_at, "2026-10-01"); assert.equal(b.payload.transferor_received_at, "2026-09-29");
  const t = b.timers.byCode("REGX_1024_41B2_ACK_5_DEEMED_T0"); assert.equal(t.length, 1); assert.equal(t[0]!.dueDate, "2026-10-08"); assert.equal(t[0]!.anchorDate, "2026-10-01");
  assert.equal(b.timers.byCode("REGX_1024_41K2_TRANSFEREE_ACK_10").length, 0, "the (k)(2) 10-day clock is for applications the transferor was already subject to");
  b.events.append({ type: "notice.sent", loanId: b.loanId, actor: AGENT, payload: { template: "NTC_REGX_41B2_ACK_INCOMPLETE" } });
  assert.equal(t[0]!.status, "satisfied");
});
test("1.7-T7: Given a transferor file missing the application's received date, then `CO-02` fails, a transferor request is sent within 2 business days, and no borrower request is made before the transferor fails to respond.", async () => {
  const r = runCarryoverChecks({ application_received_on: null, documents: [{ name: "710", received_on: D("2026-09-20") }], ack_sent_on: null }, D("2026-10-01"));
  assert.equal(r.status, "file_deficient"); assert.deepEqual(r.failed, ["CO-02"]);
  assert.equal(r.transferor_request_due, "2026-10-05");                        // +2 servicer business days (SM_LOSSMIT_MISSING_DOCS_TRANSFEROR_2)
  assert.equal(r.borrower_request_allowed, false); assert.equal(r.ask_order, "ask_transferor");
  assert.equal(borrowerRequestAllowed(r.transferor_request_due!, false, D("2026-10-05")), false);
  assert.equal(borrowerRequestAllowed(r.transferor_request_due!, false, D("2026-10-06")), true);
  assert.equal(borrowerRequestAllowed(r.transferor_request_due!, true, D("2026-10-06")), false);
  assert.deepEqual(CARRYOVER_CHECKS.map((c) => c.code), ["CO-01", "CO-02", "CO-03", "CO-04", "CO-05", "CO-06", "CO-07", "CO-08", "CO-09", "CO-10"]);
  assert.deepEqual(r.checks.filter((c) => c.result !== "n_a").map((c) => `${c.code}:${c.result}`), ["CO-01:pass", "CO-02:fail"]);
  // With events: `lossmit.carryover.deficient` arms the 2-day clock; `lossmit.transferor_request.sent` satisfies it.
  const h = harness("2026-10-01T14:00:00.000Z");
  const v = verifyCarryover(h.events, { case_id: "C-7", loan_id: "L-7" }, { application_received_on: null, documents: [{ name: "710", received_on: D("2026-09-20") }], ack_sent_on: null }, D("2026-10-01"));
  assert.equal(v.event.type, "lossmit.carryover.deficient");
  const t = h.timers.byCode("SM_LOSSMIT_MISSING_DOCS_TRANSFEROR_2"); assert.equal(t.length, 1); assert.equal(t[0]!.dueDate, "2026-10-05");
  h.clock.set("2026-10-02T14:00:00.000Z"); const req = requestFromTransferor(h.events, { case_id: "C-7", loan_id: "L-7" }, ["CO-02 application received date"], D("2026-10-02"));
  assert.equal(req.borrower_asked, false); assert.equal(t[0]!.status, "satisfied");
  const complete = verifyCarryover(h.events, { case_id: "C-8", loan_id: "L-8" }, { application_received_on: D("2026-09-20"), documents: [{ name: "710", received_on: D("2026-09-20") }], ack_sent_on: D("2026-09-22"), ack_copy_document_id: "doc-ack", completeness: "incomplete", reasonable_date: D("2026-10-24") }, D("2026-10-01"));
  assert.equal(complete.event.type, "lossmit.carryover.verified"); assert.equal(complete.status, "file_verified");
  // SM_LOSSMIT_FILE_VERIFY_T0: armed on the batch-scoped lossmit tape (T-0 = transfer date); the per-case events do not close it — the batch roll-up does once no case is deficient.
  const b = harness("2026-09-17T14:00:00.000Z");
  const svc = new BoardingService({ events: b.events, ledger: new MemoryLedger(), ext: new FakePositions(), clock: b.clock, clearingAccountId: "CUST-CLEARING" });
  svc.openBatch(batchContext({ transfer_date: T })); svc.ingestTape("B1", "lossmit", "case_id,loan_id,application_received_on\nC-7,L-7,\nC-8,L-8,2026-09-20\n", 2);
  const t0 = b.timers.byCode("SM_LOSSMIT_FILE_VERIFY_T0"); assert.equal(t0.length, 1); assert.deepEqual(t0[0]!.subject, { kind: "transfer_batch", id: "B1" }); assert.equal(t0[0]!.dueDate, "2026-10-01");
  const good: TransferorLossmitFile = { application_received_on: D("2026-09-20"), documents: [{ name: "710", received_on: D("2026-09-20") }], ack_sent_on: D("2026-09-22"), ack_copy_document_id: "doc-ack", completeness: "incomplete", reasonable_date: D("2026-10-24") };
  const deficient = verifyBatchCarryover(b.events, { batch_id: "B1", transfer_date: T }, [{ case_id: "C-7", loan_id: "L-7", file: { ...good, application_received_on: null } }, { case_id: "C-8", loan_id: "L-8", file: good }], D("2026-09-17"));
  assert.equal(deficient.verified, false); assert.deepEqual(deficient.deficient, ["C-7"]); assert.equal(deficient.event, null); assert.equal(t0[0]!.status, "armed");
  assert.equal(b.timers.byCode("SM_LOSSMIT_MISSING_DOCS_TRANSFEROR_2").length, 1, "the deficient case arms its own 2-day transferor-request clock");
  assert.throws(() => verifyBatchCarryover(b.events, { batch_id: "B1", transfer_date: T }, []), RangeError);
  b.clock.set("2026-09-22T14:00:00.000Z");
  const verified = verifyBatchCarryover(b.events, { batch_id: "B1", transfer_date: T }, [{ case_id: "C-7", loan_id: "L-7", file: good }, { case_id: "C-8", loan_id: "L-8", file: good }], D("2026-09-22"));
  assert.equal(verified.verified, true); assert.deepEqual(verified.event!.aggregate, { kind: "transfer_batch", id: "B1" }); assert.equal(verified.event!.payload.all_cases, true);
  assert.ok(eventMatches(b.registry.get("SM_LOSSMIT_FILE_VERIFY_T0")!.satisfiedPattern!, verified.event!)); assert.equal(t0[0]!.status, "satisfied");
  // On the bus (op=batch) the same roll-up writes one lossmit_carryover_checks row per check per case.
  const k = bus("2026-09-22T14:00:00.000Z", "L-7");
  const out = (await k.run("runCarryoverChecks", { op: "batch", batch_id: "B1", transfer_date: "2026-10-01", boarded_on: "2026-09-22", cases: [{ case_id: "C-7", loan_id: "L-7", file: good }] })).output as { verified: boolean };
  assert.equal(out.verified, true); assert.equal(k.rt.store.list("lossmit_carryover_checks").length, 10);
  await assert.rejects(k.run("requestFromTransferor", { case_id: "C-7", items: ["CO-02"], ask_borrower: true }), (e: unknown) => e instanceof CommandRefused && e.code === "TRANSFEROR_BEFORE_BORROWER");
});
test("1.7-T8: Given a forbearance history of 9 cumulative months starting Feb. 1, 2026, then a 3-month extension is allowed and a further extension is refused by `FNMA_LL_2026_01_FORBEARANCE_CUMULATIVE_12M` without an exception record.", () => {
  assert.deepEqual(forbearanceCarryover(9, 3), { allowed_months: 3, exception_required: false });
  assert.deepEqual(forbearanceCarryover(12, 3), { allowed_months: 0, exception_required: true });
  assert.deepEqual(forbearanceCarryover(9, 6), { allowed_months: 3, exception_required: true });
  assert.equal(evaluateGate("1.7.forbearanceCumulativeWithin12Months", { cumulative_months: 9, requested_months: 3 }).open, true);
  const refused = evaluateGate("1.7.forbearanceCumulativeWithin12Months", { cumulative_months: 12, requested_months: 3 }); assert.equal(refused.open, false); assert.match(refused.reason!, /LL-2026-01/);
  assert.equal(evaluateGate("1.7.forbearanceCumulativeWithin12Months", { cumulative_months: 12, requested_months: 3, fnma_exception_approved: true }).open, true);
  // The gate arms from the real boarding path on the transferor's forbearance history (anchor = initial start date).
  const b = boardInherited({ application_present: true, application_received_on: D("2026-01-15"), completeness: "complete", ack_sent_on: D("2026-01-20"), ack_copy_document_id: "doc-ack", determination: { kind: "offer", sent_on: D("2026-01-28"), notice_document_id: "doc-offer" }, offer: { option: "forbearance", offered_at: D("2026-01-28"), acceptance_deadline: D("2026-02-11"), terms: { payment_cents: 0n } }, borrower_response: "accepted", forbearance_history: { initial_start_date: D("2026-02-01"), cumulative_months: 9, increments: [{ start: D("2026-02-01"), months: 3 }, { start: D("2026-05-01"), months: 3 }, { start: D("2026-08-01"), months: 3 }] } }, { application_status: "forbearance" });
  assert.deepEqual(b.payload.forbearance_history, { initial_start_date: "2026-02-01", cumulative_months: 9, increments: [{ start: "2026-02-01", months: 3 }, { start: "2026-05-01", months: 3 }, { start: "2026-08-01", months: 3 }] });
  assert.equal(b.payload.lossmit_offer_pending, false, "an accepted offer is not pending");
  const t = b.timers.byCode("FNMA_LL_2026_01_FORBEARANCE_CUMULATIVE_12M"); assert.equal(t.length, 1); assert.equal(t[0]!.note, "evaluator:1.7.forbearanceCumulativeWithin12Months"); assert.equal(t[0]!.anchorDate, "2026-02-01");
});
test("1.7-T9: Given the AI proposes a denial, then the determination notice cannot be sent without a `lossmit_reviewer` approval record.", async () => {
  const proposed = { kind: "denial" as const, proposed_by: { kind: "agent" as const, id: "lossmit-underwriter" } };
  assert.equal(denialSendGate(proposed, null).ok, false);
  assert.equal(denialSendGate(proposed, { by: { kind: "human", id: "u-ops", role: "ops_analyst" }, decision_id: "d1" }).ok, false);
  assert.equal(denialSendGate(proposed, { by: REVIEWER, decision_id: "d2" }).ok, true);
  assert.equal(denialSendGate({ kind: "offer", proposed_by: proposed.proposed_by }, null).ok, true);
  // On the bus: the agent's draftNotice for the (c)(1) denial is refused without the reviewer's approval record; with it the render proceeds.
  const k = bus("2026-10-20T14:00:00.000Z", "L-9");
  const before = k.events.all().length;
  await assert.rejects(k.run("draftNotice", { template_code: "NTC_REGX_41C1_DENIAL", loan_id: "L-9" }), (e: unknown) => e instanceof CommandRefused && e.code === "DENIAL_NEEDS_LOSSMIT_REVIEWER");
  assert.deepEqual(k.events.all().slice(before).map((e) => e.type), ["command.refused"]);
  const rendered = await k.run("draftNotice", { template_code: "NTC_REGX_41C1_DENIAL", loan_id: "L-9", reviewer_approval_id: "d2", recipients: [{ name: "Borrower 1", address: "1 Main St" }], payload: {} }).then((r) => r.output as { id: string }, (e: unknown) => e);
  assert.ok(!(rendered instanceof CommandRefused), "with the reviewer's approval record the guardrail passes");
});
test("1.7-T10: Given `regx.lossmit.2024nprm` is switched on for new cases, then inherited cases keep `deemed_received_at` and their existing timers are cancelled with reason `rule_set_change` and re-issued under the new definitions.", () => {
  const clock = new FixedClock("2026-10-01T14:00:00.000Z"); const events = new MemoryEventStore(clock);
  const reg = registry();
  const timers = new TimerEngine(reg, events, { processes: ["1.7"] });
  const boarded = events.append({ type: "loan.boarded", loanId: "L-17", actor: SYSTEM, payload: { transfer_date: "2026-10-01", ...inflightBoardingFacts({ in_process: true, inherited_file: { application_received_on: D("2026-09-29"), completeness: "incomplete", ack_sent_on: null } }, T) } });
  const before = timers.byCode("REGX_1024_41K2_TRANSFEREE_ACK_10"); assert.equal(before.length, 1); assert.equal(before[0]!.dueDate, "2026-10-16");
  const r = reissueTimersForRuleSet(timers, reg, events, "L-17", boarded, "regx.lossmit.2024nprm", SYSTEM);
  assert.deepEqual(r.cancelled, ["REGX_1024_41K2_TRANSFEREE_ACK_10"]); assert.deepEqual(r.reissued, ["REGX_1024_41K2_TRANSFEREE_ACK_10"]); assert.equal(r.deemed_received_at, "2026-09-29");
  assert.equal(before[0]!.status, "cancelled"); assert.equal(before[0]!.cancelledReason, "rule_set_change");
  const after = timers.byCode("REGX_1024_41K2_TRANSFEREE_ACK_10"); assert.equal(after.length, 2); assert.equal(after[1]!.status, "armed");
  assert.equal(events.ofType("timer.cancelled")[0]!.payload.reason, "rule_set_change");
});

// ---- timers the T-ids do not name: SM_SMDU_CASE_ACCESS_T0 and the trial-plan status at boarding ----
test("1.7 SM_SMDU_CASE_ACCESS_T0: a trial plan in progress boards as lossmit_status=trial_in_progress; the SMDU case answering under the partner's servicer number satisfies the T-0 clock, an inaccessible case opens the fnma_portal_operator request package", async () => {
  const trial = { schedule: [{ due_on: D("2026-10-01"), amount_cents: 199_480n }, { due_on: D("2026-11-01"), amount_cents: 199_480n }, { due_on: D("2026-12-01"), amount_cents: 199_480n }] };
  const b = boardInherited({ application_present: true, application_received_on: D("2026-08-01"), completeness: "complete", ack_sent_on: D("2026-08-05"), ack_copy_document_id: "doc-ack", determination: { kind: "offer", sent_on: D("2026-09-01"), notice_document_id: "doc-offer" }, offer: { option: "Flex Modification trial period plan", offered_at: D("2026-09-01"), acceptance_deadline: D("2026-09-15"), terms: { payment_cents: 199_480n } }, borrower_response: "accepted", trial, workout_in_smdu: true, smdu_case_id: "SMDU-77" }, { application_status: "trial" });
  assert.equal(b.payload.lossmit_status, "trial_in_progress"); assert.equal(b.payload.smdu_case_id, "SMDU-77");
  const t = b.timers.byCode("SM_SMDU_CASE_ACCESS_T0"); assert.equal(t.length, 1); assert.equal(t[0]!.dueDate, "2026-10-01");
  const esc = new EscalationService(b.events, b.clock);
  const bad = smduCaseAccessChecked(b.events, esc, { case_id: "C-s", loan_id: b.loanId, smdu_case_id: "SMDU-77", partner_servicer_number: "123456789", transfer_date: T, record: { case_id: "SMDU-77", servicer_number: "999999999", status: "tpp_active" } }, T);
  assert.equal(bad.accessible, false); assert.match(bad.reason!, /servicer number 999999999/); assert.equal(bad.event.type, "smdu.case.inaccessible"); assert.ok(bad.portal_task_id);
  const task = b.events.ofType("escalation.created").find((e) => e.payload.escalation_id === bad.portal_task_id)!;
  assert.equal(task.payload.owner_role, "fnma_portal_operator"); assert.equal(task.payload.kind, "human_portal_task"); assert.equal(task.payload.task, "smdu_case_continuity_request");
  assert.deepEqual((task.payload.request_package as { loans: { smdu_case_id: string }[]; transfer_date: string }).loans.map((l) => l.smdu_case_id), ["SMDU-77"]);
  assert.equal(t[0]!.status, "armed");
  const good = smduCaseAccessChecked(b.events, esc, { case_id: "C-s", loan_id: b.loanId, smdu_case_id: "SMDU-77", partner_servicer_number: "123456789", transfer_date: T, record: { case_id: "SMDU-77", servicer_number: "123456789", status: "tpp_active" } }, T);
  assert.equal(good.accessible, true); assert.equal(good.event.type, "smdu.case.accessible"); assert.equal(t[0]!.status, "satisfied");
  // the same check through the bus (evaluateOptions op=smdu_access) — a record is required
  const k = bus("2026-10-01T14:00:00.000Z", b.loanId, b.events);
  const out = (await k.run("evaluateOptions", { op: "smdu_access", case_id: "C-s", loan_id: b.loanId, smdu_case_id: "SMDU-77", partner_servicer_number: "123456789", transfer_date: "2026-10-01", record: { case_id: "SMDU-77", servicer_number: "123456789", status: "tpp_active" } })).output as { accessible: boolean };
  assert.equal(out.accessible, true);
  await assert.rejects(k.run("evaluateOptions", { op: "smdu_access", case_id: "C-s" }), RangeError);
  // an in-process application without a trial boards as lossmit_in_process; a loan with no loss mitigation carries the flag and nothing else
  assert.equal(inflightBoardingFacts({ in_process: true, inherited_file: { application_received_on: D("2026-09-29") } }, T).lossmit_status, "lossmit_in_process");
  assert.equal(Object.values(inflightBoardingFacts({ in_process: false }, T)).filter((v) => v !== null && v !== false).length, 0, "no clock fact on a loan without loss mitigation");
});
