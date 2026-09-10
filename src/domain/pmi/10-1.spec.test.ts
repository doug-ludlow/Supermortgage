// 10.1 Borrower-requested cancellation @80% LTV
// spec/sections/10-pmi-administration/10-1-borrower-requested-cancellation-80-ltv.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import { zonedEpochMs } from "../../kernel/calendar/zoned.ts";
import { eventMatches, SYSTEM } from "../../kernel/events/index.ts";
import { levelPayment, ratePercent } from "../../kernel/money/cents.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { ltvBps, evaluateCancellation, paymentHistory, valueCheck, valuationValidUntil, valuationExpired, premiumStopAnchor, type CancellationRequest } from "./cancellation.ts";
import { finalizationClocks } from "./termination.ts";
import { ltvDenialContent } from "./denial.ts";
import { WORKED_LOAN, installmentLedger } from "./fixtures.ts";
import { decisionClock, mnRequestOverlay, smduOutageFallback } from "./ops.ts";
import { escalateDecisionClockBreach, tabulatedFeeFor, feeIsTabulated, hpaCovered, cancelBasisOnRecord, type OpenedCase, type SmduEvaluateResult } from "./ops-10-1.ts";
import { harness, BORROWER } from "./spec-harness.ts";

const OV = WORKED_LOAN.original_value_cents;
const REG = loadOverriddenRegistry();
const trigger = (code: string) => REG.get(code)!.triggerPattern!;
/** The worked loan's request as the `pmi.*` evaluate input (original-value path unless overridden). */
const request = (o: Record<string, unknown> = {}): Record<string, unknown> => ({ loan_id: "L-101", received_on: "2029-07-10", decision_on: "2029-07-15", original_value_cents: OV, evaluation_upb_cents: 31995095n, consummation: "2024-03-15", avm_cents: 45500000n, installments: installmentLedger(70, { "2029-06-01": "2029-06-14" }, D("2029-07-01")), ...o });
/** The worked loan's inbound request as the `pmi.*` request input (1-unit principal residence consummated 2024-03-15 → HPA-covered). */
const inbound = (o: Record<string, unknown> = {}): Record<string, unknown> => ({ op: "request", loan_id: "L-101", received_at: "2029-07-10", channel: "written", basis: "original_value", requester_party_id: "B1", state: "TX", units: 1, occupancy: "principal", consummation: "2024-03-15", ...o });
const domainRequest = (o: Partial<CancellationRequest> = {}): CancellationRequest => ({ received_on: D("2029-07-10"), decision_on: D("2029-07-15"), evidence_satisfied_on: null, path: "original_value", property_class: "1u_principal_or_second", hpa_covered: true, original_value_cents: OV, valuation_cents: null, valuation_delivered_on: null, evaluation_upb_cents: 31995095n, threshold_reached_on: null, installments: installmentLedger(70, { "2029-06-01": "2029-06-14" }, D("2029-07-01")), avm_cents: 45500000n, consummation: D("2024-03-15"), ...o });

test("10.1-T1: Given the worked loan and a written request 2029-07-10 with actual UPB $319,950.95, clean history and AVM $455,000, when evaluated, then result `eligible`, effective 2029-07-10, `HPA_4904B_DENIAL_NOTICE_30` satisfied by the cancellation notice, LAR 89 code 51 queued.", async () => {
  const h = harness("2029-07-10T14:00:00.000Z", "L-101");
  // the written request is ingested through the bus: `mi.cancel.requested` (the request clocks' trigger) and the `pmi_cancel` case in `received`
  const opened = (await h.run("10.1", "pmi.*", inbound({ received_at: "2029-07-10T14:00:00.000Z" }))) as OpenedCase;
  assert.equal(opened.status, "received"); assert.equal(opened.hpa_covered, true); assert.equal(opened.hpa_path, true); assert.equal(opened.state_overlay, null);
  assert.equal(opened.received_on, D("2029-07-10")); assert.equal(opened.decision_due, D("2029-08-09")); assert.equal(opened.ack_due, D("2029-07-12")); assert.equal(opened.ack_due, addBusinessDays(D("2029-07-10"), 2, servicer)); assert.equal(opened.original_value_decision_due, D("2029-07-17"));
  assert.equal(h.rt.store.get("mi_cases", opened.case_id)!.data.status, "received"); assert.equal(h.rt.store.get("cases", opened.case_id)!.data.case_type, "pmi_cancel");
  const req = h.events.ofType("mi.cancel.requested"); assert.equal(req.length, 1); const ev = req[0]!;
  assert.equal(ev.actor.id, "pmi"); assert.equal(ev.loanId, "L-101"); assert.equal(ev.payload.received_at, "2029-07-10"); assert.equal(ev.payload.channel, "written"); assert.equal(ev.payload.state, "TX"); assert.equal(ev.payload.owner_occupied, true); assert.equal(ev.payload.hpa_covered, true);
  for (const code of ["HPA_4904B_DENIAL_NOTICE_30", "HPA_4902A4_EVIDENCE_DISCLOSURE_2BD", "SM_MI_ORIGINAL_VALUE_DECISION_5BD"]) { assert.ok(eventMatches(trigger(code), ev), code); assert.equal(h.latest(code).status, "armed", code); assert.equal(h.latest(code).anchorDate, D("2029-07-10"), code); }
  assert.equal(eventMatches(trigger("MN_47_207_RESPONSE_30"), ev), false); assert.equal(h.timer("MN_47_207_RESPONSE_30").length, 0);
  assert.equal(h.latest("HPA_4904B_DENIAL_NOTICE_30").dueDate, D("2029-08-09")); assert.equal(h.latest("HPA_4902A4_EVIDENCE_DISCLOSURE_2BD").dueDate, D("2029-07-12")); assert.equal(h.latest("SM_MI_ORIGINAL_VALUE_DECISION_5BD").dueDate, D("2029-07-17"));
  await assert.rejects(h.run("10.1", "pmi.*", inbound()), /already has open pmi_cancel case pmi-cancel-L-101-2029-07-10/);   // one open case per loan
  await assert.rejects(h.run("10.1", "pmi.*", inbound({ loan_id: "L-101x", channel: "fax" })), /channel fax is not one of written\/verbal\/portal\/sii/);
  // a cancel with no evaluation on record is refused before anything runs
  assert.equal((await h.refused("10.1", "pmi.*", { op: "cancel", loan_id: "L-101", evaluation: { result: "eligible", effective_on: "2020-01-01", lar89_action_code: "51" }, received_on: "2029-07-10" })).code, "CANCEL_NEEDS_ELIGIBLE_EVALUATION");
  h.clock.set("2029-07-15T14:00:00.000Z");
  const d = (await h.run("10.1", "pmi.*", { op: "evaluate", ...request() })) as { result: string; ltv_bps: number; effective_on: string; lar89_action_code: string; evaluation_id: string };
  assert.equal(d.result, "eligible"); assert.equal(d.ltv_bps, 7998); assert.equal(d.effective_on, D("2029-07-10")); assert.equal(d.lar89_action_code, "51");
  assert.equal(h.latest("SM_MI_ORIGINAL_VALUE_DECISION_5BD").status, "satisfied");
  // a forged evaluation id is refused; the recorded eligible evaluation grants, with the effective date and LAR 89 code taken from the stored row
  assert.equal((await h.refused("10.1", "pmi.*", { op: "cancel", loan_id: "L-101", evaluation: { ...d, evaluation_id: "eval-forged" }, received_on: "2029-07-10" })).code, "CANCEL_NEEDS_ELIGIBLE_EVALUATION");
  assert.equal(cancelBasisOnRecord({ evaluation_id: d.evaluation_id }, h.events.byLoan("L-101"))!.kind, "eligible_evaluation");
  const c = (await h.run("10.1", "pmi.*", { op: "cancel", loan_id: "L-101", evaluation: { ...d, effective_on: "2020-01-01" }, received_on: "2029-07-10" })) as { event: string; effective: string; lar89: { code: string; line: string }; evaluation_id: string; cancel_basis: string };
  assert.equal(c.event, "mi.cancelled"); assert.equal(c.effective, D("2029-07-10")); assert.equal(c.lar89.line, "89 0 L-101 51 071029"); assert.equal(c.evaluation_id, d.evaluation_id); assert.equal(c.cancel_basis, "eligible_evaluation");
  assert.equal(h.rt.store.get("mi_cases", opened.case_id)!.data.status, "cancellation_issued"); assert.equal(h.rt.store.get("mi_cases", opened.case_id)!.data.cancellation_effective_date, D("2029-07-10"));
  assert.deepEqual(h.events.ofType("mi.coverage.ended").map((e) => e.payload.kind), ["cancelled"]);
  assert.equal(h.latest("HPA_4904A_TERMINATION_NOTICE_30").dueDate, D("2029-08-09")); assert.equal(h.latest("HPA_4902F1_REFUND_45").dueDate, D("2029-08-24")); assert.equal(h.latest("HPA_4902E_STOP_PREMIUM_30").dueDate, D("2029-08-09"));
  // LAR 89 code 51 queued to fnma-lsdu satisfies the internal buffer target
  await h.run("10.1", "investor_events.emit", { loan_id: "L-101", action_code: "51", action_date: "071029" });
  assert.equal(h.events.ofType("investor_events.queued")[0]!.payload.legacy_record, 89); assert.equal(h.latest("SM_MI_LAR89_INTERNAL_TARGET_NEXTBD_2000").status, "satisfied");
  // the cancellation notice satisfies the HPA 30-day clock (and the 4904(a) termination-notice clock)
  h.clock.set("2029-07-16T14:00:00.000Z");
  const n = (await h.run("10.1", "notices.render/send", { template_code: "NTC_HPA_4904A_CANCELLED", loan_id: "L-101", recipients: BORROWER, payload: { ...h.sample("NTC_HPA_4904A_CANCELLED"), notice_date: "2029-07-16", effective_on: "2029-07-10", termination_phrase: "was cancelled at your request" } })) as { status: string; rendered: { text: string } };
  assert.equal(n.status, "sent"); assert.match(n.rendered.text, /effective July 10, 2029/);
  assert.equal(h.latest("HPA_4904B_DENIAL_NOTICE_30").status, "satisfied"); assert.equal(h.latest("HPA_4904A_TERMINATION_NOTICE_30").status, "satisfied");
  assert.equal(h.latest("HPA_4902F1_REFUND_45").status, "armed");
});
test("10.1-T2: Given the 2027-07-10 request with UPB $335,548.68, then `ineligible` with reason `LTV_ABOVE_THRESHOLD` (8388 bps), denial notice sent no later than 2027-08-09, timer satisfied on send.", async () => {
  const h = harness("2027-07-10T14:00:00.000Z", "L-102");
  const opened = (await h.run("10.1", "pmi.*", inbound({ loan_id: "L-102", received_at: "2027-07-10" }))) as OpenedCase;
  assert.equal(opened.decision_due, D("2027-08-09")); assert.equal(h.events.ofType("mi.cancel.requested").length, 1);
  h.clock.set("2027-07-13T14:00:00.000Z");
  const d = (await h.run("10.1", "pmi.*", { op: "evaluate", ...request({ loan_id: "L-102", received_on: "2027-07-10", decision_on: "2027-07-13", evaluation_upb_cents: 33554868n, avm_cents: null, installments: installmentLedger(40, {}, D("2027-07-01")) }) })) as { result: string; reasons: string[]; ltv_bps: number; decision_due: string; evaluation_id: string };
  assert.equal(d.result, "ineligible"); assert.deepEqual(d.reasons, ["LTV_ABOVE_THRESHOLD"]); assert.equal(d.ltv_bps, 8388); assert.equal(d.decision_due, D("2027-08-09"));
  assert.equal(ltvBps(33554868n, OV), 8388);
  const clock = h.latest("HPA_4904B_DENIAL_NOTICE_30"); assert.equal(clock.dueDate, D("2027-08-09")); assert.equal(clock.status, "armed"); assert.equal(clock.armedByEventId, h.events.ofType("mi.cancel.requested")[0]!.id);
  assert.equal(h.latest("SM_MI_DENIAL_SEND_5BD").dueDate, addBusinessDays(D("2027-07-13"), 5, servicer));
  // an ineligible decision never reaches `cancellation_issued`
  assert.equal((await h.refused("10.1", "pmi.*", { op: "cancel", loan_id: "L-102", evaluation: d, received_on: "2027-07-10" })).code, "CANCEL_NEEDS_ELIGIBLE_EVALUATION");
  h.clock.set("2027-07-14T14:00:00.000Z");
  const n = (await h.run("10.6", "notices.*", { template_code: "NTC_HPA_4904B_DENIAL", loan_id: "L-102", evaluation_id: d.evaluation_id, recipients: BORROWER, payload: h.sample("NTC_HPA_4904B_DENIAL") })) as { status: string; sentAt: string };
  assert.equal(n.status, "sent"); assert.ok(n.sentAt.slice(0, 10) <= "2027-08-09");
  assert.equal(clock.status, "satisfied"); assert.equal(clock.satisfiedAt, "2027-07-14T14:00:00.000Z"); assert.equal(h.latest("SM_MI_DENIAL_SEND_5BD").status, "satisfied");
});
test("10.1-T3: Given a request received 2029-07-10 and no decision or notice by 2029-08-09 23:59 servicer time, then timer `breached`, `officer` sev-1 escalation, Sentinel report line.", async () => {
  const h = harness("2029-07-10T14:00:00.000Z", "L-103");
  await h.run("10.1", "pmi.*", inbound({ loan_id: "L-103" }));
  const t = h.latest("HPA_4904B_DENIAL_NOTICE_30"); assert.equal(t.dueDate, D("2029-08-09")); assert.equal(t.dueAt, zonedEpochMs(D("2029-08-09"), "23:59", "America/New_York"));
  // 23:58 servicer time on the due date: still open; 23:59: breached by the engine with the registry's severity and role
  h.clock.set("2029-08-10T03:58:59.000Z");
  assert.ok(!h.timers.evaluate(h.clock.now()).some((b) => b.def.code === "HPA_4904B_DENIAL_NOTICE_30")); assert.equal(t.status, "armed");
  h.clock.set("2029-08-10T03:59:00.000Z");
  const b = h.timers.evaluate(h.clock.now()).find((x) => x.def.code === "HPA_4904B_DENIAL_NOTICE_30")!;
  assert.equal(t.status, "breached"); assert.equal(b.severity, 1); assert.deepEqual([...b.escalateTo], ["officer"]); assert.match(b.breachText, /Compliance Sentinel daily report/);
  assert.equal(h.events.ofType("timer.breached").filter((e) => e.payload.code === "HPA_4904B_DENIAL_NOTICE_30").length, 1);
  // the breach opens the officer sev-1 escalation carrying the Sentinel report line
  const r = escalateDecisionClockBreach(b, { escalations: h.escalations, actor: SYSTEM, received_on: D("2029-07-10") });
  const esc = h.escalations.opened.find((e) => e.id === r.escalation_id)!;
  assert.equal(esc.kind, "officer"); assert.equal(esc.ownerRole, "officer"); assert.equal(esc.severity, "sev1"); assert.equal(esc.loanId, "L-103"); assert.equal(esc.slaTimerId, t.id); assert.equal(esc.status, "open");
  assert.match(r.sentinel_line, /^HPA_4904B_DENIAL_NOTICE_30 breached: request received 2029-07-10; no decision or notice by 2029-08-09 23:59 servicer time/); assert.equal(esc.payload.sentinel_line, r.sentinel_line); assert.equal(esc.payload.report, "Compliance Sentinel daily report");
  assert.equal(h.events.ofType("escalation.created").at(-1)!.payload.sentinel_line, r.sentinel_line);
  // the pure clock agrees
  const open = decisionClock({ received_on: D("2029-07-10"), decided_on: null, notice_sent_on: null, now: D("2029-08-09") });
  assert.equal(open.due, D("2029-08-09")); assert.equal(open.status, "open");
  const late = decisionClock({ received_on: D("2029-07-10"), decided_on: null, notice_sent_on: null, now: D("2029-08-10") });
  assert.equal(late.status, "breached"); assert.deepEqual(late.escalation, { role: "officer", severity: 1 }); assert.match(late.sentinel_line!, /HPA_4904B_DENIAL_NOTICE_30 breached: request received 2029-07-10; no decision or notice by 2029-08-09 23:59 servicer time/);
  assert.equal(decisionClock({ received_on: D("2029-07-10"), decided_on: D("2029-07-12"), notice_sent_on: D("2029-07-13"), now: D("2029-08-10") }).status, "satisfied");
});
test("10.1-T4: Given a 30-day late (paid 2028-11-05 for the 2028-10-01 installment) inside window B, then `ineligible` reason `PAYMENT_HISTORY_30_12M`; given the same late flagged disaster-attributable with plan compliance, then excluded and `eligible`.", () => {
  const led = installmentLedger(70, { "2028-10-01": "2028-11-05", "2028-11-01": "2028-11-05" }, D("2029-07-01"));   // both paid 11-05 (FIFO: Oct satisfied 35 days late)
  const h = paymentHistory(led, D("2029-07-10"));
  assert.equal(h.reason, "PAYMENT_HISTORY_30_12M"); assert.equal(h.offending[0]!.days_late, 35); assert.equal(h.offending[0]!.due_date, D("2028-10-01")); assert.equal(h.late30_12m, 1);
  const denied = evaluateCancellation(domainRequest({ installments: led }));
  assert.equal(denied.result, "ineligible"); assert.deepEqual(denied.reasons, ["PAYMENT_HISTORY_30_12M"]);
  const excused = evaluateCancellation(domainRequest({ installments: led, disaster_excluded: new Set([D("2028-10-01")]) }));
  assert.equal(excused.result, "eligible"); assert.equal(excused.history.offending.length, 0); assert.equal(excused.effective_on, D("2029-07-10"));
  // a 60-day late in window A only → the 24-month test; a 45-day late there is fine
  assert.equal(paymentHistory(installmentLedger(70, { "2027-10-01": "2027-12-05", "2027-11-01": "2027-12-05", "2027-12-01": "2027-12-05" }, D("2029-07-01")), D("2029-07-10")).reason, "PAYMENT_HISTORY_60_24M");
  assert.ok(paymentHistory(installmentLedger(70, { "2027-10-01": "2027-11-15", "2027-11-01": "2027-11-15" }, D("2029-07-01")), D("2029-07-10")).ok);
});
test("10.1-T5: Given AVM $395,000 < original $400,000, then case → `value_check_needed`, ack lists $190 BPO option and AVM disclaimer; when $190 posts, then order placed within 1 BD; when BPO $412,000 delivered, then `value_not_declined=true` and grant.", async () => {
  const h = harness("2029-07-10T14:00:00.000Z", "L-105");
  await h.run("10.1", "pmi.*", inbound({ loan_id: "L-105", channel: "portal" }));
  assert.equal(h.latest("HPA_4902A4_EVIDENCE_DISCLOSURE_2BD").status, "armed");
  h.clock.set("2029-07-12T14:00:00.000Z");
  const d = (await h.run("10.1", "pmi.*", { op: "evaluate", ...request({ loan_id: "L-105", decision_on: "2029-07-12", avm_cents: 39500000n }) })) as { result: string; reasons: string[] };
  assert.equal(d.result, "value_check_needed"); assert.deepEqual(d.reasons, ["VALUE_DECLINED_OR_UNKNOWN"]);
  const vc = valueCheck(39500000n, OV, 1); assert.equal(vc.status, "value_check_needed"); assert.equal(vc.status === "value_check_needed" && vc.options[0]!.fee_cents, 19000n); assert.equal(tabulatedFeeFor("bpo_int_ext"), 19000n);
  assert.equal(h.latest("FNMA_F102_VALUATION_FEE_GATE").status, "armed"); assert.equal(h.latest("SM_MI_FEE_WAIT_60").dueDate, D("2029-09-10"));
  // the ack lists the $190 BPO option and carries the AVM disclaimer; without an AVM value the checklist still passes (the evidence letter is never held)
  const ack = (await h.run("10.1", "notices.render/send", { template_code: "NTC_HPA_4902A_ACK_EVIDENCE", loan_id: "L-105", recipients: BORROWER, payload: { ...h.sample("NTC_HPA_4902A_ACK_EVIDENCE"), notice_date: "2029-07-11", upb_cents: 31995095n, avm_value_cents: 39500000n, avm_disclaimer: true } })) as { status: string; rendered: { text: string } };
  assert.equal(ack.status, "sent"); assert.match(ack.rendered.text, /broker price opinion \(\$190\.00\)/); assert.match(ack.rendered.text, /\$395,000\.00 was developed by an automated valuation model/);
  assert.equal(h.latest("HPA_4902A4_EVIDENCE_DISCLOSURE_2BD").status, "satisfied");
  const noAvm = h.notices.render({ templateCode: "NTC_HPA_4902A_ACK_EVIDENCE", loanId: "L-105", recipients: BORROWER, payload: { ...h.sample("NTC_HPA_4902A_ACK_EVIDENCE"), avm_value_cents: null }, asOf: D("2029-07-11") });
  assert.equal(noAvm.status, "rendered"); assert.equal(noAvm.checklist.passed, true); assert.equal(noAvm.checklist.results.find((r) => r.rule_id === "avm-disclaimer")!.skipped, true);
  assert.equal((await h.refused("10.1", "notices.render/send", { template_code: "NTC_HPA_4902A_ACK_EVIDENCE", loan_id: "L-105", recipients: BORROWER, payload: { ...h.sample("NTC_HPA_4902A_ACK_EVIDENCE"), avm_value_cents: 39500000n } })).code, "AVM_DISCLAIMER");
  // F-1-02: only the tabulated fee for the kind can be charged or ordered; the order is refused until the fee posts; the fee receipt opens the gate and the order goes within 1 BD
  assert.equal((await h.refused("10.1", "smdu.*", { op: "valuation.order", loan_id: "L-105", kind: "bpo_int_ext", fee_cents: 25000n })).code, "ONLY_TABULATED_FEE");
  assert.equal((await h.refused("10.1", "smdu.*", { op: "valuation.order", loan_id: "L-105", kind: "bpo_int_ext", fee_cents: 45000n })).code, "ONLY_TABULATED_FEE");   // $450 is the restricted-appraisal fee, not the BPO's
  assert.equal((await h.refused("10.1", "smdu.*", { op: "valuation.order", loan_id: "L-105", kind: "bpo_int_ext", fee_cents: 19000n })).code, "FNMA_F102_VALUATION_FEE_GATE");
  const feeSet = (fee: bigint) => ({ effectiveDate: "2029-07-16", description: "BPO fee receipt", lines: [{ account: { scope: "custodial", custodialAccountId: "C-CLR", account: "clearing_cash" }, amountCents: fee, ruleRef: "10.1 ledger: fee receipt" }, { account: { scope: "corporate", account: "fnma_payable" }, amountCents: -fee, ruleRef: "10.1 ledger: mi_valuation_fee_payable" }] });
  h.clock.set("2029-07-16T15:00:00.000Z");
  assert.equal((await h.refused("10.1", "ledger.post", { loan_id: "L-105", valuation_fee: true, fee_cents: 25000n, funding_account: "corporate_clearing", received_on: "2029-07-16", entry_set: feeSet(25000n) })).code, "ONLY_TABULATED_FEE");
  assert.equal(h.ctx.ledger.sets().length, 0); assert.equal(feeIsTabulated(75000n, "appraisal_1025"), true); assert.equal(feeIsTabulated(75000n, "bpo_int_ext"), false);
  await h.run("10.1", "ledger.post", { loan_id: "L-105", valuation_fee: true, fee_cents: 19000n, valuation_kind: "bpo_int_ext", funding_account: "corporate_clearing", received_on: "2029-07-16", entry_set: feeSet(19000n) });
  assert.equal(h.latest("FNMA_F102_VALUATION_FEE_GATE").status, "satisfied"); assert.equal(h.latest("SM_MI_FEE_WAIT_60").status, "satisfied");
  const order = (await h.run("10.1", "smdu.*", { op: "valuation.order", loan_id: "L-105", kind: "bpo_int_ext", fee_cents: 19000n })) as { ordered: boolean; ordered_on: string };
  assert.equal(order.ordered, true); assert.ok(order.ordered_on <= addBusinessDays(D("2029-07-16"), 1, servicer));
  // the BPO replaces the AVM: value not declined → grant
  h.clock.set("2029-07-30T15:00:00.000Z");
  await h.run("10.1", "smdu.*", { op: "valuation.delivered", loan_id: "L-105", delivered_on: "2029-07-30", value_cents: 41200000n, kind: "bpo_int_ext", borrower_paid: true });
  assert.equal(h.latest("FNMA_SMDU_VALUATION_VALID_120").dueDate, D("2029-11-27")); assert.equal(h.latest("FNMA_B8104_DENIAL_NOTICE_30").dueDate, D("2029-08-29")); assert.equal(h.latest("FNMA_B8104_DENIAL_NOTICE_30").status, "armed");
  assert.equal(valueCheck(41200000n, OV, 1).status, "value_not_declined");
  const g = (await h.run("10.1", "pmi.*", { op: "evaluate", ...request({ loan_id: "L-105", decision_on: "2029-07-31", evidence_satisfied_on: "2029-07-16", avm_cents: 39500000n, valuation_cents: 41200000n, valuation_delivered_on: "2029-07-30" }) })) as { result: string; effective_on: string; lar89_action_code: string; evaluation_id: string };
  assert.equal(g.result, "eligible"); assert.equal(g.effective_on, D("2029-07-16")); assert.equal(g.lar89_action_code, "51");
  const c = (await h.run("10.1", "pmi.*", { op: "cancel", loan_id: "L-105", evaluation: g, received_on: "2029-07-10", evidence_satisfied_on: "2029-07-16" })) as { event: string; effective: string };
  assert.equal(c.event, "mi.cancelled"); assert.equal(c.effective, D("2029-07-16")); assert.equal(h.latest("FNMA_SMDU_VALUATION_VALID_120").status, "satisfied");
  // the grant's cancellation notice closes the B-8.1-04 30-day clock too (a granted borrower-paid case never breaches it)
  h.clock.set("2029-08-01T15:00:00.000Z");
  await h.run("10.1", "notices.render/send", { template_code: "NTC_HPA_4904A_CANCELLED", loan_id: "L-105", recipients: BORROWER, payload: { ...h.sample("NTC_HPA_4904A_CANCELLED"), notice_date: "2029-08-01", effective_on: "2029-07-16", termination_phrase: "was cancelled at your request" } });
  assert.equal(h.latest("FNMA_B8104_DENIAL_NOTICE_30").status, "satisfied"); assert.equal(h.latest("HPA_4904B_DENIAL_NOTICE_30").status, "satisfied"); assert.equal(h.latest("HPA_4904A_TERMINATION_NOTICE_30").status, "satisfied");
  assert.ok(!h.timers.evaluate("2029-09-01T12:00:00.000Z").some((b) => b.def.code === "FNMA_B8104_DENIAL_NOTICE_30"));
});
test("10.1-T6: Given a 2-unit principal residence with actual LTV 72%, then Fannie Mae original-value path `ineligible` (threshold 7000) and HPA path not evaluated (`hpa_covered=false`); denial cites the 70% rule.", async () => {
  const r = evaluateCancellation(domainRequest({ property_class: "2_4u_principal", hpa_covered: false, evaluation_upb_cents: 28800000n, installments: installmentLedger(70, {}, D("2029-07-01")) }));
  assert.equal(r.result, "ineligible"); assert.equal(r.threshold_bps, 7000); assert.equal(r.ltv_bps, 7200); assert.deepEqual(r.reasons, ["LTV_ABOVE_THRESHOLD"]);
  const content = ltvDenialContent({ evaluation_upb_cents: 28800000n, value_cents: OV, ltv_bps: r.ltv_bps, threshold_bps: r.threshold_bps!, scheduled_80_date: null });
  assert.equal(content.threshold_percent, "70.00%"); assert.equal(content.balance_needed, "$280,000.00");
  // the request opens outside the HPA (2 units): `hpa_covered=false`, no HPA path; the Fannie Mae 70% rule decides
  assert.equal(hpaCovered({ units: 2, occupancy: "principal", consummation: D("2024-03-15") }), false); assert.equal(hpaCovered({ units: 1, occupancy: "principal", consummation: D("1999-07-28") }), false); assert.equal(hpaCovered({ units: 1, occupancy: "second_home", consummation: D("2024-03-15") }), false);
  const h = harness("2029-07-10T14:00:00.000Z", "L-106");
  const opened = (await h.run("10.1", "pmi.*", inbound({ loan_id: "L-106", units: 2 }))) as OpenedCase;
  assert.equal(opened.hpa_covered, false); assert.equal(opened.hpa_path, false); assert.equal(h.events.ofType("mi.cancel.requested")[0]!.payload.hpa_covered, false);
  h.clock.set("2029-07-12T14:00:00.000Z");
  const d = (await h.run("10.1", "pmi.*", { op: "evaluate", ...request({ loan_id: "L-106", decision_on: "2029-07-12", property_class: "2_4u_principal", hpa_covered: false, evaluation_upb_cents: 28800000n, installments: installmentLedger(70, {}, D("2029-07-01")) }) })) as { result: string; threshold_bps: number; ltv_bps: number; reasons: string[] };
  assert.equal(d.result, "ineligible"); assert.equal(d.threshold_bps, 7000); assert.equal(d.ltv_bps, 7200); assert.deepEqual(d.reasons, ["LTV_ABOVE_THRESHOLD"]); assert.equal(h.latest("SM_MI_DENIAL_SEND_5BD").status, "armed");
  const v = h.registry.activeVersion("NTC_HPA_4904B_DENIAL", D("2029-07-12"))!;
  const payload = { ...v.samplePayload, notice_date: "2029-07-12", received_on: "2029-07-10", grounds_text: "your loan balance is above 70 percent of the original value of your property (the Fannie Mae 70 percent rule for a two- to four-unit principal residence; the Homeowners Protection Act path does not apply to this property type).", evaluation_upb_cents: 28800000n, ltv_percent: "72.00", value_cents: OV, path_text: "Fannie Mae original value (two- to four-unit principal residence)", threshold_percent: "70.00", cure_text: "your balance must be $280,000.00 or less." };
  const rendered = render(v.source, payload);
  assert.match(rendered.text, /70 percent rule/); assert.match(rendered.text, /is 72\.00% of the original value of \$400,000\.00; the threshold under the path we evaluated \(Fannie Mae original value \(two- to four-unit principal residence\)\) is 70\.00%\./);
  assert.equal(evaluateChecklist(v, payload, rendered).passed, true);
});
test("10.1-T7: Given an MN owner-occupied loan, request received 2026-09-01, then `MN_47_207_RESPONSE_30` due 2026-10-01 and the ack offers the MN current-value (80% of appraisal within 90 days) path.", async () => {
  const r = mnRequestOverlay({ state: "MN", owner_occupied: true, received_on: D("2026-09-01") });
  assert.deepEqual(r.timer, { code: "MN_47_207_RESPONSE_30", due: D("2026-10-01") });
  assert.ok(r.ack_paths.includes("mn_current_value")); assert.equal(r.mn_current_value!.threshold_bps, 8000); assert.equal(r.mn_current_value!.appraisal_max_age_days, 90);
  assert.ok(r.response_types.includes("request_additional_information"));
  assert.equal(mnRequestOverlay({ state: "MN", owner_occupied: false, received_on: D("2026-09-01") }).timer, null);
  // through the bus: the request carries `state=MN, owner_occupied=true`, which arms the §47.207 jurisdiction clock from receipt
  const h = harness("2026-09-01T14:00:00.000Z", "L-107");
  const opened = (await h.run("10.1", "pmi.*", inbound({ loan_id: "L-107", received_at: "2026-09-01", basis: "unspecified", state: "MN", owner_occupied: true }))) as OpenedCase;
  assert.equal(opened.state_overlay, "MN_47_207"); assert.deepEqual(opened.overlay.timer, { code: "MN_47_207_RESPONSE_30", due: D("2026-10-01") }); assert.deepEqual([...opened.overlay.ack_paths], ["hpa_original_value", "fnma_original_value", "mn_current_value"]);
  const ev = h.events.ofType("mi.cancel.requested")[0]!; assert.equal(ev.payload.state, "MN"); assert.equal(ev.payload.owner_occupied, true); assert.ok(eventMatches(trigger("MN_47_207_RESPONSE_30"), ev));
  const mn = h.latest("MN_47_207_RESPONSE_30"); assert.equal(mn.status, "armed"); assert.equal(mn.anchorDate, D("2026-09-01")); assert.equal(mn.dueDate, D("2026-10-01")); assert.equal(mn.armedByEventId, ev.id);
  assert.equal(h.latest("HPA_4904B_DENIAL_NOTICE_30").dueDate, D("2026-10-01"));
  // the acknowledgment offers the MN current-value path (80% of an appraisal made within 90 days, at the borrower's cost)
  const ack = (await h.run("10.1", "notices.render/send", { template_code: "NTC_HPA_4902A_ACK_EVIDENCE", loan_id: "L-107", recipients: BORROWER, payload: { ...h.sample("NTC_HPA_4902A_ACK_EVIDENCE"), notice_date: "2026-09-02", received_on: "2026-09-01", window_end: "2026-09-01", avm_value_cents: null, mn_overlay: opened.overlay.mn_current_value !== null } })) as { status: string; rendered: { text: string } };
  assert.equal(ack.status, "sent"); assert.match(ack.rendered.text, /and under Minnesota law/); assert.match(ack.rendered.text, /Under Minnesota law \(Minn\. Stat\. 47\.207\) you may also request cancellation when your unpaid principal balance is 80 percent or less of the current fair market value shown by an appraisal made within the last 90 days, at your cost/);
  assert.equal(h.latest("HPA_4902A4_EVIDENCE_DISCLOSURE_2BD").status, "satisfied"); assert.equal(mn.status, "armed");   // the ack is not the §47.207 approve / request-info / deny response
  // not owner-occupied → no MN clock (the overlay is owner-occupied only)
  const h2 = harness("2026-09-01T14:00:00.000Z", "L-107b");
  await h2.run("10.1", "pmi.*", inbound({ loan_id: "L-107b", received_at: "2026-09-01", state: "MN", occupancy: "investment", owner_occupied: false }));
  assert.equal(h2.timer("MN_47_207_RESPONSE_30").length, 0); assert.equal(h2.latest("HPA_4904B_DENIAL_NOTICE_30").status, "armed");
});
test("10.1-T8: Given SMDU 503 for 4 hours at case day 16, then a `human_portal_task` escalation opens with the prepared data set and the HPA timer unchanged.", async () => {
  const r = smduOutageFallback({ outage_hours: 4, case_day: 16, hpa_due: D("2029-08-09"), data_set: { total_upb_cents: 31995095n, is_current: true, late30_12m: 0, late60_24m: 0 } });
  assert.equal(r.escalation!.kind, "human_portal_task"); assert.equal(r.escalation!.owner_role, "fnma_portal_operator"); assert.equal(r.escalation!.package.total_upb_cents, 31995095n);
  assert.deepEqual(r.hpa_timer, { code: "HPA_4904B_DENIAL_NOTICE_30", due: D("2029-08-09"), changed: false }); assert.equal(r.retry, false);
  assert.equal(smduOutageFallback({ outage_hours: 2, case_day: 16, hpa_due: D("2029-08-09"), data_set: {} }).retry, true);
  assert.equal(smduOutageFallback({ outage_hours: 6, case_day: 10, hpa_due: D("2029-08-09"), data_set: {} }).escalation, null);
  // through the bus: the request on 2029-07-10, SMDU answering 503 from 10:00 on 2029-07-25 (case day 16)
  const h = harness("2029-07-10T14:00:00.000Z", "L-108");
  await h.run("10.1", "pmi.*", inbound({ loan_id: "L-108" }));
  const hpa = h.latest("HPA_4904B_DENIAL_NOTICE_30"); const armedBefore = h.events.ofType("timer.armed").length;
  const dataSet = { total_upb_cents: 31995095n, property_usage: "principal", units: 1, is_current: true, late30_12m: 0, late60_24m: 0, disaster_attestation: "N" };
  const evaluate = () => h.run("10.1", "smdu.*", { op: "evaluate", loan_id: "L-108", fnma_loan_number: "1234567890", request_type: "original_value", data_set: dataSet }) as Promise<SmduEvaluateResult>;
  h.smdu.controls.failNext(99);
  h.clock.set("2029-07-25T10:00:00.000Z");
  const first = await evaluate();
  assert.equal(first.unavailable, true); assert.ok(first.unavailable && first.retry); assert.equal(first.unavailable && first.case_day, 16); assert.equal(first.unavailable && first.outage_hours, 0); assert.equal(h.escalations.opened.length, 0);
  assert.equal(h.rt.store.get("smdu_outages", "L-108")!.data.since, "2029-07-25T10:00:00.000Z"); assert.equal(h.events.ofType("mi.smdu.unavailable").length, 1);
  h.clock.set("2029-07-25T14:00:00.000Z");
  const second = await evaluate();
  assert.ok(second.unavailable && !second.retry); assert.equal(second.unavailable && second.outage_hours, 4); assert.equal(second.unavailable && second.case_day, 16);
  assert.deepEqual(second.unavailable && second.hpa_timer, { code: "HPA_4904B_DENIAL_NOTICE_30", due: D("2029-08-09"), changed: false });
  const esc = h.escalations.opened[0]!; assert.equal(esc.id, second.unavailable && second.escalation_id); assert.equal(esc.kind, "human_portal_task"); assert.equal(esc.ownerRole, "fnma_portal_operator"); assert.equal(esc.loanId, "L-108"); assert.equal(esc.caseId, "pmi-cancel-L-108-2029-07-10");
  const pkg = esc.payload.package as Record<string, unknown>;
  assert.equal(pkg.total_upb_cents, 31995095n); assert.equal(pkg.is_current, true); assert.equal(pkg.late30_12m, 0); assert.equal(pkg.late60_24m, 0); assert.equal(pkg.fnma_loan_number, "1234567890"); assert.equal(pkg.channel, "SMDU UI evaluation"); assert.equal(pkg.hpa_due, D("2029-08-09"));
  assert.equal(h.rt.store.get("mi_cases", "pmi-cancel-L-108-2029-07-10")!.data.status, "escalated");
  // the HPA clock is untouched: the same instance, still armed, due 2029-08-09, no re-arm or cancel
  assert.equal(h.latest("HPA_4904B_DENIAL_NOTICE_30").id, hpa.id); assert.equal(hpa.status, "armed"); assert.equal(hpa.dueDate, D("2029-08-09")); assert.equal(h.timer("HPA_4904B_DENIAL_NOTICE_30").length, 1);
  assert.equal(h.events.ofType("timer.armed").length, armedBefore); assert.equal(h.events.ofType("timer.cancelled").length, 0);
  // service restored: the evaluation goes through SMDU and the outage record clears
  h.smdu.controls.failNext(0); h.clock.set("2029-07-25T15:00:00.000Z");
  const ok = await evaluate();
  assert.ok(!ok.unavailable && /^SMDU-/.test(ok.smdu_evaluation_id)); assert.equal(!ok.unavailable && ok.liability_relief, true); assert.equal(h.events.ofType("mi.smdu.evaluated").length, 1);
  assert.equal(h.rt.store.get("smdu_outages", "L-108")!.data.cleared_at, "2029-07-25T15:00:00.000Z"); assert.equal(hpa.status, "armed");
});
test("10.1-T9: Given a curtailment posted after the request bringing LTV to 79.90%, when the decision runs, then `eligible` with effective date = curtailment posting date.", () => {
  const r = evaluateCancellation(domainRequest({ decision_on: D("2029-07-20"), evaluation_upb_cents: 31960000n, threshold_reached_on: D("2029-07-15"), installments: installmentLedger(70, {}, D("2029-07-01")) }));
  assert.equal(r.result, "eligible"); assert.equal(r.ltv_bps, 7990); assert.equal(r.effective_on, D("2029-07-15")); assert.equal(r.lar89_action_code, "51");
  // 4902(e)(1): the premium stop still runs from the later of receipt and the evidence-satisfied date (no evidence here → receipt), not from the later effective date
  const clocks = finalizationClocks(r.effective_on!, "51", servicer, premiumStopAnchor(D("2029-07-10"), null));
  assert.equal(clocks.premium_stop_by, D("2029-08-09")); assert.equal(clocks.notice_due, D("2029-08-14")); assert.equal(clocks.refund_due, D("2029-08-29")); assert.equal(clocks.lar89.action_date, "071529");
  assert.equal(premiumStopAnchor(D("2029-07-10"), D("2029-07-16")), D("2029-07-16"));
});
test("10.1-T10: Given the agent attempts `pmi.set_original_value` without an evidence document, then the command is rejected and logged.", async () => {
  const h = harness("2029-07-10T14:00:00.000Z", "L-110");
  const before = h.seq();
  const e = await h.refused("10.1", "pmi.*", { op: "set_original_value", loan_id: "L-110", original_value_cents: 41000000n });
  assert.equal(e.code, "ORIGINAL_VALUE_NEEDS_EVIDENCE");
  assert.deepEqual(h.since(before).map((x) => [x.type, x.payload.code]), [["command.refused", "ORIGINAL_VALUE_NEEDS_EVIDENCE"]]);
  assert.equal(h.rt.store.get("mi_policies", "L-110"), undefined); assert.equal(h.ctx.decisions.length, 0);
  const ok = (await h.run("10.1", "pmi.*", { op: "set_original_value", loan_id: "L-110", original_value_cents: 41000000n, evidence_document_id: "DOC-APPRAISAL-1" })) as { original_value_cents: bigint };
  assert.equal(ok.original_value_cents, 41000000n);
  assert.deepEqual(h.since(before).map((x) => x.type).filter((t) => t.startsWith("mi.")), ["mi.original_value.set", "mi.original_value.corrected"]);
});
test("10.1-T11: Given a servicer-overridden `late30_12m` in the SMDU request, then `liability_relief=false` and `FNMA_SMDU_DATA_CORRECTION_30` started.", async () => {
  const h = harness("2029-07-15T14:00:00.000Z", "L-111");
  assert.equal((await h.refused("10.1", "pmi.*", { op: "evaluate", ...request({ loan_id: "L-111", overrides: ["late30_12m"] }) })).code, "HISTORY_NEEDS_EVIDENCE");
  const d = (await h.run("10.1", "pmi.*", { op: "evaluate", ...request({ loan_id: "L-111", overrides: ["late30_12m"], evidence_document_id: "DOC-HISTORY-1" }) })) as { result: string; evaluation_id: string };
  assert.equal(d.result, "eligible");
  const ev = h.events.ofType("mi.evaluation.completed")[0]!;
  assert.equal(ev.payload.liability_relief, false); assert.equal(ev.payload.servicer_overridden, true); assert.deepEqual(ev.payload.overrides, ["late30_12m"]);
  assert.equal(h.rt.store.get("mi_evaluations", d.evaluation_id)!.data.liability_relief, false);
  const t = h.latest("FNMA_SMDU_DATA_CORRECTION_30"); assert.equal(t.status, "armed"); assert.equal(t.dueDate, D("2029-08-14"));
  // a clean evaluation keeps liability relief and starts no correction clock
  const h2 = harness("2029-07-15T14:00:00.000Z", "L-111b");
  await h2.run("10.1", "pmi.*", { op: "evaluate", ...request({ loan_id: "L-111b" }) });
  assert.equal(h2.events.ofType("mi.evaluation.completed")[0]!.payload.liability_relief, true); assert.equal(h2.timer("FNMA_SMDU_DATA_CORRECTION_30").length, 0);
  // the correction reported and acked by Fannie Mae (5.1) closes it
  await h.run("10.1", "investor_events.emit", { loan_id: "L-111", event_type: "mi_data_correction", fields: ["late30_12m"] });
  h.raise("investor_events.acked", { type: "mi_data_correction" });
  assert.equal(t.status, "satisfied");
});
test("10.1-T12: Given the BPO delivered 2026-09-03, then `valid_until=2027-01-01`; a decision attempted 2027-01-02 is refused pending a new valuation.", async () => {
  assert.equal(valuationValidUntil(D("2026-09-03")), D("2027-01-01"));
  assert.equal(valuationExpired(D("2026-09-03"), D("2027-01-01")), false); assert.equal(valuationExpired(D("2026-09-03"), D("2027-01-02")), true);
  const cv = (decision: string): CancellationRequest => domainRequest({ received_on: D("2026-08-20"), decision_on: D(decision), evidence_satisfied_on: D("2026-08-24"), path: "current_value", valuation_cents: 50000000n, valuation_delivered_on: D("2026-09-03"), evaluation_upb_cents: 37052240n, installments: installmentLedger(30, {}, D("2026-08-01")), avm_cents: null });
  assert.equal(evaluateCancellation(cv("2027-01-01")).result, "eligible");
  const late = evaluateCancellation(cv("2027-01-02"));
  assert.equal(late.result, "refused"); assert.deepEqual(late.reasons, ["VALUATION_EXPIRED"]); assert.equal(late.effective_on, null);
  const h = harness("2027-01-02T14:00:00.000Z", "L-112");
  const input = { loan_id: "L-112", received_on: "2026-08-20", decision_on: "2027-01-02", evidence_satisfied_on: "2026-08-24", path: "current_value", original_value_cents: OV, valuation_cents: 50000000n, valuation_delivered_on: "2026-09-03", evaluation_upb_cents: 37052240n, consummation: "2024-03-15", installments: installmentLedger(30, {}, D("2026-08-01")) };
  const e = await h.refused("10.1", "pmi.*", { op: "evaluate", ...input });
  assert.equal(e.code, "VALUATION_EXPIRED"); assert.match(e.message, /new valuation/);
  assert.equal(h.events.ofType("mi.evaluation.completed").length, 0);
  assert.equal(((await h.run("10.1", "pmi.*", { op: "evaluate", ...input, decision_on: "2027-01-01" })) as { result: string }).result, "eligible");
});

test("10.1 worked figures: P&I $2,401.86; current-value request UPB $370,522.40 at BPO $500,000 → 74.10%", () => {
  assert.equal(levelPayment(WORKED_LOAN.upb_cents, ratePercent(WORKED_LOAN.rate_pct), WORKED_LOAN.term_months), 240186n);
  assert.equal(ltvBps(37052240n, 50000000n), 7410); assert.equal(ltvBps(37052240n, 49000000n), 7561);   // R3 floors: 75.61% (the spec prints the rounded 75.62%)
});
