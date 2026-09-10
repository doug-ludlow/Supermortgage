// 11.5 Imminent default evaluation
// spec/sections/11-early-intervention-collections/11-5-imminent-default-evaluation.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import { evaluate, hti, representativeScore, noticeDeadlines, evaluationEvents, smduSubmission, smduDecision, reviewerDecision, evaluationNoticeSent, offerAccepted, type Evaluation } from "./imminent-default.ts";
import { adverseNoticeSchedule, counterofferAcceptance, bspSendCheck, brpCompleteness, coloradoDecisionFlow, smduB2bOutage, completePortalTask, evaluationMatrix, chapter13Substitution } from "./ops.ts";
import { eiEngine, atEt, noonEt } from "./spec-harness.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { FixedClock, type Actor } from "../../kernel/events/index.ts";
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, type ToolRuntime } from "../../app/tools.ts";
import { bindTools, toolKey } from "../../app/tools/index.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { FakePrintMail } from "../../infra/integrations/delivery.ts";

const BASE = { evaluation_date: D("2026-10-20"), regx_days_delinquent: 0, principal_residence: true, brp_complete: true, oldest_doc_date: D("2026-09-26"), cash_reserves_cents: 840000n, hardship_documented: true };
const A: Evaluation = { ...BASE, hardship_type: "death_of_borrower_or_wage_earner" };
const B: Evaluation = { ...BASE, hardship_type: "reduction_in_income", credit: { scores: [601, 612, 620], fico_date: D("2026-10-20"), delinquencies_30_in_6m: 1, pitia_cents: 241250n, gross_income_cents: 560000n } };

test("11.5-T1: Given example A, then `eligible_hardship` with no credit pull, SMDU submitted by 2026-10-22, and the Evaluation Notice sent by 2026-10-26 (≤2026-11-19).", () => {
  const r = evaluate(A); assert.equal(r.outcome, "eligible_hardship"); if (r.outcome === "eligible_hardship") { assert.equal(r.path, "modification"); assert.deepEqual(r.tests, { occupancy: true, brp_complete: true, doc_age: true, cash_reserves: true }); }
  assert.equal(A.credit, undefined);   // no credit pull on the hardship path (data minimization; 11.5-Q4)
  const ev = evaluationEvents(A, r, { loan_id: "L-ID", brp_complete_on: D("2026-10-20") });
  assert.deepEqual(ev.map((e) => e.type), ["imminent_default.evaluating", "imminent_default.eligible"]); assert.equal(ev[0]!.payload.path, "hardship"); assert.equal(ev[1]!.payload.credit_pull, false); assert.equal(ev[1]!.payload.imminent_default_indicator, true); assert.equal(ev[1]!.payload.eligibility_date, D("2026-10-20"));
  const sub = smduSubmission({ loan_id: "L-ID", submitted_on: D("2026-10-21"), eligibility_date: D("2026-10-20"), ack: { case_id: "SMDU-1", acknowledged_on: D("2026-10-21") } });
  assert.equal(sub.due, D("2026-10-22")); assert.equal(sub.on_time, true); assert.deepEqual(sub.events.map((e) => e.type), ["smdu.case.submitted", "smdu.submission.acknowledged"]);
  assert.equal(smduSubmission({ loan_id: "L-ID", submitted_on: D("2026-10-23"), eligibility_date: D("2026-10-20"), ack: { case_id: "SMDU-1", acknowledged_on: D("2026-10-23") } }).on_time, false);
  const decided = smduDecision({ loan_id: "L-ID", decision: "approved", decided_on: D("2026-10-21"), current_at_evaluation: true, brp_complete_on: D("2026-10-20"), workout: "flex_modification_trial_4m" });
  assert.deepEqual(decided.map((e) => e.type), ["smdu.case.decided"]);
  assert.deepEqual(noticeDeadlines(D("2026-10-21"), D("2026-10-20")), { evaluation_notice_due: D("2026-10-26"), response_window_days: 14 });
  const sent = evaluationNoticeSent({ loan_id: "L-ID", notice_id: "ntc-eval-1", template: "NTC_FNMA_EVAL_NOTICE_STREAMLINED", sent_on: D("2026-10-23") });
  assert.equal(sent[0]!.type, "lossmit.evaluation_notice.sent"); assert.ok(D("2026-10-23") <= D("2026-10-26") && D("2026-10-26") <= D("2026-11-19"));
  // the registry: 12.1's complete-BRP determination (`lossmit.application.completed{complete_date}`, the platform's spelling of the spec's
  // `lossmit.brp.complete`, emitted by the 12.1 tool lossmit.application.open/update) arms REGX_1024_41C1_EVALUATE_30 due complete + 30 = 2026-11-19;
  // `imminent_default.eligible{eligibility_date}` arms SM_ID_SMDU_SUBMIT_2BD due 2 servicer BD = Thu 2026-10-22 (the ack on 10-21 satisfies it);
  // the SMDU decision on 10-21 arms FNMA_D2205_DECISION_5D_30D due 10-26; the Evaluation Notice sent 10-23 satisfies both 30-day and 5-day clocks
  const h = eiEngine({ loanId: "L-ID" });
  h.emit("lossmit.application.completed", { application_id: "lma-L-ID-2026-10-15", status: "complete", received_date: D("2026-10-15"), complete_at: D("2026-10-20"), complete_date: D("2026-10-20"), oldest_income_document_date: D("2026-09-26") }, noonEt("2026-10-20"));
  assert.equal(h.armed("REGX_1024_41C1_EVALUATE_30").length, 1); assert.equal(h.armed("REGX_1024_41C1_EVALUATE_30")[0]!.dueDate, D("2026-11-19"));
  for (const e of ev) h.emit(e.type, e.payload, noonEt("2026-10-20"));
  assert.equal(h.armed("SM_ID_SMDU_SUBMIT_2BD")[0]!.dueDate, D("2026-10-22"));
  for (const e of sub.events) h.emit(e.type, e.payload, noonEt("2026-10-21")); assert.equal(h.byCode("SM_ID_SMDU_SUBMIT_2BD")[0]!.status, "satisfied");
  for (const e of decided) h.emit(e.type, e.payload, noonEt("2026-10-21")); assert.equal(h.armed("FNMA_D2205_DECISION_5D_30D")[0]!.dueDate, D("2026-10-26"));
  h.emit("notice.sent", { notice_id: "ntc-eval-1", template: "NTC_FNMA_EVAL_NOTICE_STREAMLINED", sent_at: noonEt("2026-10-23") }, noonEt("2026-10-23"));
  assert.equal(h.byCode("REGX_1024_41C1_EVALUATE_30")[0]!.status, "satisfied"); assert.equal(h.byCode("FNMA_D2205_DECISION_5D_30D")[0]!.status, "satisfied");
  assert.deepEqual(h.breachCodes(atEt("2026-11-20", "00:05")).filter((c) => /EVALUATE_30|DECISION_5D|SMDU_SUBMIT/.test(c)), []);
  // without the notice the 30-day clock breaches the morning after 2026-11-19
  const silent = eiEngine({ loanId: "L-ID" }); silent.emit("lossmit.application.completed", { application_id: "lma-2", status: "complete", complete_date: D("2026-10-20") }, noonEt("2026-10-20"));
  assert.deepEqual(silent.breachCodes(atEt("2026-11-19", "23:00")).filter((c) => /EVALUATE_30/.test(c)), []); assert.deepEqual(silent.breachCodes(atEt("2026-11-20", "00:05")).filter((c) => /EVALUATE_30/.test(c)), ["REGX_1024_41C1_EVALUATE_30"]);
});
test("11.5-T2: Given example B, then representative score 612, `delinquency_pass=false`, `hti_ratio=0.43080357`, `eligible_credit`; given income $6,031.25, then `hti_pass=false` and (with no other path) `ineligible` → reviewer.", () => {
  assert.equal(representativeScore([601, 612, 620]), 612);
  const h = hti(241250n, 560000n); assert.equal(h.ratio.toFixed(8), "0.43080357"); assert.equal(h.pass, true); assert.equal(h.display, "0.43");
  const r = evaluate(B); assert.equal(r.outcome, "eligible_credit"); if (r.outcome === "eligible_credit") { assert.equal(r.tests.delinquency, false); assert.equal(r.tests.hti, true); assert.equal(r.tests.fico, true); }
  const flat = hti(241250n, 603125n); assert.equal(flat.ratio.toFixed(8), "0.40000000"); assert.equal(flat.pass, false);   // not "greater than 40 %"
  const B2: Evaluation = { ...B, credit: { ...B.credit!, gross_income_cents: 603125n } };
  const r2 = evaluate(B2); assert.equal(r2.outcome, "ineligible"); if (r2.outcome === "ineligible") assert.deepEqual(r2.failed, ["delinquency_and_hti"]);
  const ev = evaluationEvents(B2, r2, { loan_id: "L-ID", brp_complete_on: D("2026-10-20") });
  assert.equal(ev[1]!.type, "imminent_default.reviewer_pending"); assert.equal(ev[1]!.payload.reason, "ineligible"); assert.equal(ev[1]!.payload.brp_complete_at, D("2026-10-20"));
  assert.equal(reviewerDecision({ loan_id: "L-ID", reviewer_id: "reviewer-42", on: D("2026-10-21"), action: "approved" })[0]!.type, "lossmit.decision.reviewed");
});
test('11.5-T3: Given reserves of exactly $25,000.00, then `cash_reserves_pass=false` (strict "less than"); given $24,999.99, then true.', () => {
  const exact = evaluate({ ...A, cash_reserves_cents: 2500000n }); assert.equal(exact.outcome, "ineligible"); if (exact.outcome === "ineligible") assert.deepEqual(exact.failed, ["cash_reserves"]);
  const under = evaluate({ ...A, cash_reserves_cents: 2499999n }); assert.equal(under.outcome, "eligible_hardship"); if (under.outcome === "eligible_hardship") assert.equal(under.tests.cash_reserves, true);
  assert.equal(evaluateGate("11.5.cashReserveBelow25000", { cash_reserves_cents: 2500000n }).open, false); assert.equal(evaluateGate("11.5.cashReserveBelow25000", { cash_reserves_cents: 2499999n }).open, true);
});
test("11.5-T4: Given `regx_days_delinquent = 59` on the evaluation date, then the window test passes; given 60, then `rerouted_delinquent` and 12.8's delinquent track opens.", () => {
  assert.equal(evaluate({ ...A, regx_days_delinquent: 59 }).outcome, "eligible_hardship"); assert.equal(evaluateGate("11.5.delinquentUnder60", { regx_days_delinquent: 59 }).open, true);
  const sixty = { ...A, regx_days_delinquent: 60 }; const r = evaluate(sixty); assert.equal(r.outcome, "rerouted_delinquent"); assert.equal(evaluateGate("11.5.delinquentUnder60", { regx_days_delinquent: 60 }).open, false);
  const ev = evaluationEvents(sixty, r, { loan_id: "L-ID" }); assert.equal(ev[1]!.type, "imminent_default.rerouted_delinquent"); assert.equal(ev[1]!.payload.track, "12.8 delinquent");
});
test("11.5-T5: Given a FICO dated 91 days before the evaluation date, then `FNMA_D2101_FICO_AGE_90` fails and a fresh pull is required before any decision.", () => {
  const old = evaluate({ ...B, credit: { ...B.credit!, fico_date: D("2026-07-21") } }); assert.equal(old.outcome, "ineligible"); if (old.outcome === "ineligible") assert.deepEqual(old.failed, ["FNMA_D2101_FICO_AGE_90"]);
  assert.equal(evaluateGate("11.5.ficoFresh", { fico_date: "2026-07-21", evaluation_date: "2026-10-20" }).open, false);
  assert.equal(evaluateGate("11.5.ficoFresh", { fico_date: "2026-07-22", evaluation_date: "2026-10-20" }).open, true);
  assert.equal(evaluate({ ...B, credit: { ...B.credit!, fico_date: D("2026-07-22") } }).outcome, "eligible_credit");   // a fresh pull (≤90 days) unblocks the decision
});
test('11.5-T6: Given PCS orders to a station 52.0 miles away on the liquidation track, then the reserve test is waived and the occupancy test accepts "was the principal residence"; given 49.9 miles, then the exception does not apply.', () => {
  // the servicemember moved out on the orders: the property "was the principal residence" — the occupancy test passes on that basis, the reserve test is waived
  const pcs = evaluate({ ...A, hardship_type: "distant_transfer_or_pcs_gt_50mi", pcs_distance_miles: 52.0, cash_reserves_cents: 4000000n, principal_residence: false, was_principal_residence: true });
  assert.equal(pcs.outcome, "eligible_hardship"); if (pcs.outcome === "eligible_hardship") { assert.equal(pcs.path, "liquidation"); assert.equal(pcs.tests.cash_reserves, false); assert.equal(pcs.tests.occupancy, true); }   // reserves waived; occupancy accepted as "was the principal residence"
  assert.equal(evaluateGate("11.5.cashReserveBelow25000", { cash_reserves_cents: 4000000n, pcs_over_50_miles: true, track: "liquidation" }).open, true);
  // a property the servicemember never occupied fails the occupancy test even with PCS orders ("must have been or currently be" the principal residence)
  const never = evaluate({ ...A, hardship_type: "distant_transfer_or_pcs_gt_50mi", pcs_distance_miles: 52.0, principal_residence: false }); assert.equal(never.outcome, "ineligible"); if (never.outcome === "ineligible") assert.deepEqual(never.failed, ["occupancy"]);
  assert.equal(evaluate({ ...A, hardship_type: "distant_transfer_or_pcs_gt_50mi", pcs_distance_miles: 52.0, principal_residence: true }).outcome, "eligible_hardship");   // currently the principal residence
  const near = evaluate({ ...A, hardship_type: "distant_transfer_or_pcs_gt_50mi", pcs_distance_miles: 49.9 }); assert.equal(near.outcome, "ineligible"); if (near.outcome === "ineligible") assert.deepEqual(near.failed, ["pcs_distance_lt_50"]);
  assert.equal(evaluate({ ...A, hardship_type: "distant_transfer_or_pcs_gt_50mi", pcs_distance_miles: 49.9, cash_reserves_cents: 4000000n }).outcome, "ineligible");
});
test("11.5-T7: Given a current borrower declined by SMDU on 2026-10-21 with no counteroffer, then a Form 182/Reg B combined notice is due 2026-11-19 (earlier of 11-19 and 11-20) and issues only after `lossmit_reviewer` approval.", () => {
  const held = adverseNoticeSchedule({ declined_on: D("2026-10-21"), brp_complete_on: D("2026-10-20"), current_at_evaluation: true, counteroffer_accepted: false, reviewer_id: null });
  assert.equal(held.form182_due, D("2026-11-20")); assert.equal(held.regb_due, D("2026-11-19")); assert.equal(held.combined_due, D("2026-11-19")); assert.equal(held.can_issue, false); assert.match(held.blocked_by!, /reviewer_id/);
  assert.equal(adverseNoticeSchedule({ declined_on: D("2026-10-21"), brp_complete_on: D("2026-10-20"), current_at_evaluation: true, counteroffer_accepted: false, reviewer_id: "reviewer-42" }).can_issue, true);
  const ev = smduDecision({ loan_id: "L-ID", decision: "declined", decided_on: D("2026-10-21"), current_at_evaluation: true, brp_complete_on: D("2026-10-20") });
  assert.deepEqual(ev.map((e) => e.type), ["smdu.case.decided", "smdu.case.declined", "imminent_default.reviewer_pending"]); assert.equal(ev[1]!.payload.declined_on, D("2026-10-21")); assert.equal(ev[2]!.payload.reason, "smdu_declined");
  // the registry: the decline arms FNMA_D2101_FORM182_ADVERSE_30 due 11-20 and REGB_1002_9_ADVERSE_ACTION_30 due 11-19 (the earlier
  // governs the combined notice); Form 182 satisfies both, and on the delinquent-but-<60-day path (no Form 182 clock) the 12.2 denial
  // notice carries the Reg B content and satisfies the Reg B clock
  const h = eiEngine({ loanId: "L-ID" }); for (const e of ev) h.emit(e.type, e.payload, noonEt("2026-10-21"));
  assert.equal(h.armed("FNMA_D2101_FORM182_ADVERSE_30")[0]!.dueDate, D("2026-11-20")); assert.equal(h.armed("REGB_1002_9_ADVERSE_ACTION_30")[0]!.dueDate, D("2026-11-19")); assert.equal(h.armed("SM_ID_REVIEWER_SLA_2BD")[0]!.dueDate, D("2026-10-23"));
  h.emit("notice.sent", { notice_id: "n-182", template: "NTC_FNMA_A42106_FORM182_ADVERSE_ACTION", sent_at: noonEt("2026-11-19") }, noonEt("2026-11-19"));
  assert.equal(h.byCode("FNMA_D2101_FORM182_ADVERSE_30")[0]!.status, "satisfied"); assert.equal(h.byCode("REGB_1002_9_ADVERSE_ACTION_30")[0]!.status, "satisfied"); assert.deepEqual(h.breachCodes(atEt("2026-11-21", "00:05")).filter((c) => /FORM182|REGB/.test(c)), []);
  const delinquent = eiEngine({ loanId: "L-ID" }); for (const e of smduDecision({ loan_id: "L-ID", decision: "declined", decided_on: D("2026-10-21"), current_at_evaluation: false, brp_complete_on: D("2026-10-20") })) delinquent.emit(e.type, e.payload, noonEt("2026-10-21"));
  assert.equal(delinquent.byCode("FNMA_D2101_FORM182_ADVERSE_30").length, 0); assert.equal(delinquent.armed("REGB_1002_9_ADVERSE_ACTION_30").length, 1);
  delinquent.emit("notice.sent", { notice_id: "n-denial", template: "NTC_REGX_41C1_DENIAL", sent_at: noonEt("2026-11-10") }, noonEt("2026-11-10")); assert.equal(delinquent.byCode("REGB_1002_9_ADVERSE_ACTION_30")[0]!.status, "satisfied"); assert.deepEqual(delinquent.breachCodes(atEt("2026-11-20", "00:05")).filter((c) => /REGB/.test(c)), []);
  // the combined Form 182 / Reg B template carries the reviewer (no adverse notice without `reviewer_id`)
  const reg = buildRegistry(); publishAuthored(reg); const v = reg.activeVersion("NTC_FNMA_A42106_FORM182_ADVERSE_ACTION", D("2026-11-19"))!;
  assert.equal(evaluateChecklist(v, v.samplePayload, render(v.source, v.samplePayload)).passed, true); const noReviewer = { ...v.samplePayload, reviewer_id: null }; assert.equal(evaluateChecklist(v, noReviewer, render(v.source, noReviewer)).passed, false);
});
test("11.5-T8: Given a counteroffer accepted on day 10 of the 14-day window, then `FNMA_D2101_FORM182_ADVERSE_30` is cancelled.", () => {
  assert.deepEqual(counterofferAcceptance({ offer_sent_on: D("2026-10-23"), accepted_on: D("2026-11-02") }), { within_window: true, form182_timer: "cancelled" });
  assert.equal(counterofferAcceptance({ offer_sent_on: D("2026-10-23"), accepted_on: D("2026-11-07") }).form182_timer, "running");
  const acc = offerAccepted({ loan_id: "L-ID", offer_sent_on: D("2026-10-23"), accepted_on: D("2026-11-02") }); assert.equal(acc.events[0]!.type, "lossmit.offer.accepted"); assert.deepEqual([...acc.cancel_timers], ["FNMA_D2101_FORM182_ADVERSE_30"]); assert.deepEqual(acc.events[0]!.payload.cancel_timers, ["FNMA_D2101_FORM182_ADVERSE_30"]);
  assert.deepEqual([...offerAccepted({ loan_id: "L-ID", offer_sent_on: D("2026-10-23"), accepted_on: D("2026-11-07") }).cancel_timers], []);
  // the registry: the decline (with the counteroffer) arms FNMA_D2101_FORM182_ADVERSE_30 and FNMA_D2205_ACCEPT_14; the acceptance on day 10
  // satisfies the 14-day clock and cancels the Form 182 clock (`counteroffer_accepted`); a day-15 acceptance leaves it running
  const h = eiEngine({ loanId: "L-ID" }); for (const e of smduDecision({ loan_id: "L-ID", decision: "declined", decided_on: D("2026-10-21"), current_at_evaluation: true, brp_complete_on: D("2026-10-20") })) h.emit(e.type, e.payload, noonEt("2026-10-21"));
  h.emit("lossmit.offer.sent", { kind: "counteroffer", sent: "2026-10-23" }, noonEt("2026-10-23")); assert.equal(h.armed("FNMA_D2205_ACCEPT_14")[0]!.dueDate, D("2026-11-06")); assert.equal(h.armed("FNMA_D2101_FORM182_ADVERSE_30").length, 1);
  for (const e of acc.events) h.emit(e.type, e.payload, noonEt("2026-11-02"));
  assert.equal(h.byCode("FNMA_D2205_ACCEPT_14")[0]!.status, "satisfied"); assert.equal(h.byCode("FNMA_D2101_FORM182_ADVERSE_30")[0]!.status, "cancelled"); assert.equal(h.byCode("FNMA_D2101_FORM182_ADVERSE_30")[0]!.cancelledReason, "counteroffer_accepted");
  assert.deepEqual(h.breachCodes(atEt("2026-11-21", "00:05")).filter((c) => /FORM182/.test(c)), []);
  const late = eiEngine({ loanId: "L-ID" }); for (const e of smduDecision({ loan_id: "L-ID", decision: "declined", decided_on: D("2026-10-21"), current_at_evaluation: true, brp_complete_on: D("2026-10-20") })) late.emit(e.type, e.payload, noonEt("2026-10-21"));
  for (const e of offerAccepted({ loan_id: "L-ID", offer_sent_on: D("2026-10-23"), accepted_on: D("2026-11-07") }).events) late.emit(e.type, e.payload, noonEt("2026-11-07")); assert.equal(late.byCode("FNMA_D2101_FORM182_ADVERSE_30")[0]!.status, "armed");
});
test('11.5-T9: Given a borrower 12 days delinquent who has not asked for help, then any Form 745/BSP send is refused by `FNMA_D2101_NO_SOLICIT_LT30`; given the borrower asks "what help is there?" on a call, then the BSP is permitted with the request logged.', async () => {
  const refused = bspSendCheck({ regx_days: 12, borrower_asked_for_help: false });
  assert.equal(refused.permitted, false); assert.equal(refused.refused_by, "FNMA_D2101_NO_SOLICIT_LT30");
  const asked = bspSendCheck({ regx_days: 12, borrower_asked_for_help: true, request_logged_at: "2026-10-12T15:04:00Z" });
  assert.equal(asked.permitted, true); assert.match(asked.basis!, /borrower request logged 2026-10-12/);
  // the gate the timer asserts (FNMA_D2101_NO_SOLICIT_LT30 → evaluator 11.2.delinquentAtLeast30OrImminentDefault): 12 days and no request → closed; the borrower's request opens it
  assert.equal(evaluateGate("11.2.delinquentAtLeast30OrImminentDefault", { regx_days_delinquent: 12, imminent_default_requested: false }).open, false);
  assert.equal(evaluateGate("11.2.delinquentAtLeast30OrImminentDefault", { regx_days_delinquent: 12, imminent_default_requested: true }).open, true);
  assert.equal(evaluateGate("11.2.delinquentAtLeast30OrImminentDefault", { regx_days_delinquent: 30, imminent_default_requested: false }).open, true);
  // the real send: the 11.2 `print.request` tool on the bus refuses a BSP for the 12-day borrower with FNMA_D2101_NO_SOLICIT_LT30 (nothing but the refusal
  // event is written); with the borrower's request logged the BSP goes out and `solicitation_package.sent` / the `solicitation_packages` row carry the request
  const clock = new FixedClock("2026-10-12T15:04:00.000Z"); const h = eiEngine({ loanId: "L-ID", now: "2026-10-12T15:04:00.000Z" });
  const decisions: DecisionInput[] = []; const ctx: UowContext = { loanId: "L-ID", events: h.events, ledger: new MemoryLedger(), timers: h.engine, clock, decide: (d) => { decisions.push({ loanId: "L-ID", ...d }); } };
  const agents = new AgentRegistry(); const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(h.events, clock), services: {}, ports: { printMail: new FakePrintMail() } };
  const cmds = bindTools(rt, agents); const bus = new CommandBus(agents); const collections: Actor = { kind: "agent", id: "default-collections" };
  const bsp = { notice_id: "ntc-bsp-1", template: "NTC_FNMA_D2204_SOLICITATION_PACKAGE", regx_days_delinquent: 12, pdf: "%PDF", recipient: "borrower" };
  const before = h.events.all().length;
  await assert.rejects(bus.execute(cmds.get(toolKey("11.2", "print.request"))!, collections, bsp, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "FNMA_D2101_NO_SOLICIT_LT30");
  assert.deepEqual(h.events.all().slice(before).map((e) => e.type), ["command.refused"]); assert.equal(rt.store.list("solicitation_packages", () => true).length, 0);
  await bus.execute(cmds.get(toolKey("11.2", "print.request"))!, collections, { ...bsp, borrower_requested: true, trigger: "borrower request logged 2026-10-12T15:04:00Z (call)" }, ctx);
  const types = h.events.all().slice(before).map((e) => e.type);
  assert.ok(types.includes("solicitation_package.send_requested") && types.includes("notice.sent") && types.includes("solicitation_package.sent"), types.join(","));
  const pkg = rt.store.list("solicitation_packages", (d) => d.loan_id === "L-ID")[0]!; assert.equal(pkg.data.kind, "bsp"); assert.match(String(pkg.data.trigger), /borrower request logged 2026-10-12/);
  assert.equal(decisions.length, 1);
});
test("11.5-T10: Given income documents dated 95 days before completeness, then the BRP is incomplete and the 12.1 missing-items notice lists them.", () => {
  const r = brpCompleteness({ completeness_on: D("2026-10-20"), documents: [{ kind: "pay stub", dated: D("2026-07-17") }, { kind: "bank statement", dated: D("2026-10-01") }] });
  assert.equal(r.complete, false); assert.equal(r.missing_items.length, 1); assert.match(r.missing_items[0]!, /pay stub dated 2026-07-17/); assert.equal(r.notice, "NTC_REGX_41B2_ACK_INCOMPLETE");
  assert.equal(brpCompleteness({ completeness_on: D("2026-10-20"), documents: [{ kind: "pay stub", dated: D("2026-07-17") }], disaster_impacted: true }).complete, true);
});
test("11.5-T11: Given a Colorado loan with an AI-influenced ineligible result, then the pre-decision notice precedes the determination, the explanation lists the failed tests, and the appeal channel is offered.", () => {
  const r = coloradoDecisionFlow({ state: "CO", ai_influenced: true, result: { outcome: "ineligible", failed: ["cash_reserves", "fico_gt_620"] } });
  assert.deepEqual([...r.steps], ["NTC_CO_AI_ACT_PRE_DECISION", "determination"]); assert.deepEqual([...r.explanation], ["cash_reserves", "fico_gt_620"]); assert.match(r.appeal_channel!, /appeal/);
  assert.deepEqual([...coloradoDecisionFlow({ state: "TX", ai_influenced: true, result: { outcome: "ineligible", failed: ["occupancy"] } }).steps], ["determination"]);
});
test("11.5-T12: Given SMDU B2B unavailable for 5 hours, then a `human_portal_task` with the full package is created and completed within 1 Fannie Mae BD, and the decision PDF is attached to the evaluation.", () => {
  const r = smduB2bOutage({ unavailable_hours: 5, created_on: D("2026-10-21"), package: { loan: "L1", hardship: "death_of_borrower_or_wage_earner", imminent_default_indicator: true } });
  assert.equal(r.human_portal_task!.kind, "smdu"); assert.equal(r.human_portal_task!.owner_role, "fnma_portal_operator"); assert.equal(r.human_portal_task!.due, D("2026-10-22")); assert.equal(r.human_portal_task!.package.loan, "L1");
  const done = completePortalTask({ decision_pdf_document_id: "doc-smdu-1", task_id: r.human_portal_task!.id, completed_on: D("2026-10-22"), smdu_case_id: "SMDU-9" }); assert.equal(done.completed, true); assert.equal(done.attached, true);
  assert.equal(smduB2bOutage({ unavailable_hours: 2, created_on: D("2026-10-21"), package: {} }).retry, true); assert.deepEqual(smduB2bOutage({ unavailable_hours: 2, created_on: D("2026-10-21"), package: {} }).events, []);
  // the registry: `human_portal_task.created{kind=smdu}` arms FNMA_SMDU_PORTAL_TASK_1BD due 1 Fannie Mae business day (10-22);
  // `human_portal_task.completed{kind=smdu, decision_attached=true}` satisfies it — a completion without the decision PDF emits nothing and the task breaches sev-2
  assert.equal(r.events[0]!.type, "human_portal_task.created"); assert.equal(r.events[0]!.payload.kind, "smdu"); assert.equal(r.events[0]!.payload.sla, "1 business_days_fannie_et");
  const h = eiEngine({ loanId: "L1" }); for (const e of r.events) h.emit(e.type, e.payload, noonEt("2026-10-21"));
  assert.equal(h.armed("FNMA_SMDU_PORTAL_TASK_1BD")[0]!.dueDate, D("2026-10-22"));
  assert.deepEqual(completePortalTask({ decision_pdf_document_id: null }).events, []);
  assert.equal(done.events[0]!.type, "human_portal_task.completed"); assert.equal(done.events[0]!.payload.decision_attached, true); for (const e of done.events) h.emit(e.type, e.payload, noonEt("2026-10-22"));
  assert.equal(h.byCode("FNMA_SMDU_PORTAL_TASK_1BD")[0]!.status, "satisfied"); assert.deepEqual(h.breachCodes(atEt("2026-10-23", "00:05")), []);
  const missing = eiEngine({ loanId: "L1" }); for (const e of r.events) missing.emit(e.type, e.payload, noonEt("2026-10-21")); const b = missing.engine.evaluate(atEt("2026-10-23", "00:05")).find((x) => x.instance.code === "FNMA_SMDU_PORTAL_TASK_1BD")!; assert.equal(b.severity, 2);
});
test("11.5-T13: Given AI mode off, then the deterministic evaluation job produces the same test matrix for examples A and B (golden-file comparison) and the reviewer/notice steps are unchanged.", () => {
  const goldenA = { outcome: "eligible_hardship", path: "modification", tests: { occupancy: true, brp_complete: true, doc_age: true, cash_reserves: true } };
  const goldenB = { outcome: "eligible_credit", path: "modification", tests: { occupancy: true, brp_complete: true, doc_age: true, cash_reserves: true, fico: true, fico_age: true, delinquency: false, hti: true } };
  for (const ai of [false, true]) { assert.deepEqual(evaluationMatrix(A, ai).result, goldenA); assert.deepEqual(evaluationMatrix(B, ai).result, goldenB); assert.equal(evaluationMatrix(A, ai).reviewer_step, "lossmit_reviewer_on_adverse"); }
  assert.deepEqual(evaluationMatrix(A, false).result, evaluationMatrix(A, true).result);
});
test("11.5-T14: Given a Chapter 13 debtor, then bankruptcy schedules ≤90 days old substitute for Form 710 and communications go through counsel.", () => {
  const r = chapter13Substitution({ chapter: 13, schedules_dated: D("2026-08-01"), evaluation_date: D("2026-10-20") });
  assert.equal(r.substitute_for_form_710, true); assert.equal(r.schedule_age_days, 80); assert.equal(r.communications, "through_counsel");
  assert.equal(chapter13Substitution({ chapter: 13, schedules_dated: D("2026-07-01"), evaluation_date: D("2026-10-20") }).substitute_for_form_710, false);
  assert.equal(chapter13Substitution({ chapter: 7, schedules_dated: D("2026-10-01"), evaluation_date: D("2026-10-20") }).communications, "borrower");
});

test("11.5 worked figures: PITIA $2,412.50 = $1,650.00 + $612.50 + $150.00; income $5,600.00 → HTI 0.43 passes; $6,031.25 → 0.40 fails; reserves $8,400.00", () => {
  assert.equal(165000n + 61250n + 15000n, 241250n);
  assert.equal(hti(241250n, 560000n).pass, true); assert.equal(hti(241250n, 560000n).display, "0.43"); assert.equal(hti(241250n, 603125n).pass, false);
  assert.ok(840000n < 2500000n);
  const e: Evaluation = { evaluation_date: D("2026-10-20"), regx_days_delinquent: 0, principal_residence: true, brp_complete: true, oldest_doc_date: D("2026-09-26"), cash_reserves_cents: 840000n, hardship_type: "reduction_in_income", hardship_documented: true, credit: { scores: [601, 612, 620], fico_date: D("2026-10-20"), delinquencies_30_in_6m: 1, pitia_cents: 241250n, gross_income_cents: 603125n } };
  assert.equal(evaluate(e).outcome, "ineligible");
});
