// 10.5 Unearned premium refund
// spec/sections/10-pmi-administration/10-5-unearned-premium-refund.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { zonedEpochMs } from "../../kernel/calendar/zoned.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import { Decimal } from "../../kernel/money/decimal.ts";
import type { EntrySetInput } from "../../kernel/ledger/ledger.ts";
import { unearnedEstimate, refundClocks, reconcileInsurerRefund, refundLegs, refundApplicationAllowed, lookbackShortfall, returnedAchCheckDue } from "./refund.ts";
import { installmentLedger, WORKED_LOAN } from "./fixtures.ts";
import { ET, escrowMiLineRelease, refundEscrowEvents, insurerRescission } from "./ops.ts";
import { harness, OFFICER, PMI_AGENT, type Harness } from "./spec-harness.ts";

const TI = { scope: "custodial", custodialAccountId: "C-TI", account: "custodial_ti_cash" } as const;
const escrowOf = (loanId: string) => ({ scope: "loan", loanId, account: "escrow" } as const);
const advanceOf = (loanId: string) => ({ scope: "loan", loanId, account: "corporate_advance" } as const);
const set = (effectiveDate: string, description: string, lines: EntrySetInput["lines"], extra: Partial<EntrySetInput> = {}): EntrySetInput => ({ effectiveDate: D(effectiveDate), description, lines, ...extra });
/** End coverage on the worked loan through the sweep so the R-F clocks (refund 45, advance 40, insurer, escrow) arm on `mi.coverage.ended`. */
async function terminate(h: Harness, effective: string): Promise<void> {
  const r = (await h.run("10.2", "pmi.terminate", { loan_id: h.loanId, scheduled_date: effective, installments: installmentLedger(140, {}, D(effective)), escrowed: true })) as { result: { status: string } };
  assert.equal(r.result.status, "terminated");
}

test("10.5-T1: Given the annual-plan example (E = 2031-08-01), then `estimate_cents = 141173`, insurer timer due 2031-09-03, borrower timer due 2031-09-15; when the $1,411.73 ACH lands 2031-08-12, then match, postings (1) and (2), borrower paid 2031-08-13, timer satisfied.", async () => {
  assert.equal(unearnedEstimate({ kind: "annual", premium_cents: 228000n, anniversary_start: D("2031-03-15") }, D("2031-08-01")), 141173n);
  const c = refundClocks(D("2031-08-01"), D("2031-08-04"));
  assert.equal(c.insurer_transfer_due, D("2031-09-03")); assert.equal(c.borrower_refund_due, D("2031-09-15")); assert.equal(c.insurer_notice_due, D("2031-08-05"));
  const h = harness("2031-08-01T05:30:00.000Z", "L-51");
  await terminate(h, "2031-08-01");
  const refund = h.latest("HPA_4902F1_REFUND_45"); assert.equal(refund.dueDate, D("2031-09-15")); assert.equal(h.latest("SM_MI_REFUND_ADVANCE_40").dueDate, D("2031-09-10")); assert.equal(h.latest("SM_MI_ESCROW_INTERIM_ANALYSIS_10BD").dueDate, D("2031-08-15"));
  const est = (await h.run("10.5", "pmi.refund.estimate", { loan_id: "L-51", plan: "annual", premium_cents: 228000n, anniversary_start: "2031-03-15", effective_on: "2031-08-01", certificate: "CERT-1" })) as { refund_id: string; estimate_cents: bigint };
  assert.equal(est.estimate_cents, 141173n); assert.equal(h.rt.store.get("mi_refunds", est.refund_id)!.data.status, "awaiting_insurer");
  h.clock.set("2031-08-04T15:00:00.000Z");
  await h.run("10.5", "escrow.interim_analysis.request", { loan_id: "L-51", effective_on: "2031-08-01", mi_line_balance_cents: 95000n, monthly_mi_deposit_cents: 19000n, old_payment_cents: 289186n, analysis_on: "2031-08-06" });
  const cancel = (await h.run("10.2", "mi_insurer.cancel", { loan_id: "L-51", certificate: "CERT-1", effective_on: "2031-08-01", notified_on: "2031-08-04", reason: "automatic_78", refund_payee: "servicer" })) as { status: string };
  assert.equal(cancel.status, "accepted"); assert.equal(h.latest("HPA_4902F2_INSURER_REFUND_30").dueDate, D("2031-09-03")); assert.equal(h.latest("MI_INSURER_CANCEL_NOTICE_45").status, "satisfied");
  // the $1,411.73 ACH lands 2031-08-12 → custodial match, postings (1) insurer refund received and (2) refund to the borrower
  h.clock.set("2031-08-12T15:00:00.000Z");
  const m = (await h.run("10.5", "custodial.match", { amount_cents: 141173n, certificate: "CERT-1", received_on: "2031-08-12" })) as { matched: boolean; refund_ids: string[] };
  assert.equal(m.matched, true); assert.deepEqual(m.refund_ids, [est.refund_id]); assert.equal(h.latest("HPA_4902F2_INSURER_REFUND_30").status, "satisfied");
  assert.equal(h.events.ofType("mi.insurer.refund_received")[0]!.payload.variance_cents, 0n);
  await h.run("10.5", "ledger.post", { entry_set: set("2031-08-12", "insurer refund received", [{ account: TI, amountCents: 141173n, ruleRef: "10.5 posting (1)" }, { account: escrowOf("L-51"), amountCents: -141173n, ruleRef: "10.5 posting (1)" }]) });
  h.clock.set("2031-08-13T15:00:00.000Z");
  await h.run("10.5", "ledger.post", { entry_set: set("2031-08-13", "refund to borrower", [{ account: escrowOf("L-51"), amountCents: 141173n, ruleRef: "10.5 posting (2)" }, { account: TI, amountCents: -141173n, ruleRef: "10.5 posting (2)" }]) });
  assert.equal(h.ctx.ledger.sets().length, 2); assert.equal(h.ctx.ledger.balance(escrowOf("L-51")), 0n); assert.equal(h.ctx.ledger.balance(TI), 0n);
  const paid = (await h.run("10.5", "disbursements.issue", { loan_id: "L-51", amount_cents: 141173n, rail: "ach", status: "credited", issued_on: "2031-08-13", refund_id: est.refund_id })) as { completed: boolean; refund_paid_on: string };
  assert.equal(paid.completed, true); assert.equal(paid.refund_paid_on, D("2031-08-13"));
  assert.equal(refund.status, "satisfied"); assert.equal(refund.satisfiedAt!.slice(0, 10), "2031-08-13"); assert.equal(h.latest("SM_MI_REFUND_ADVANCE_40").status, "satisfied");
  assert.equal(h.rt.store.get("mi_refunds", est.refund_id)!.data.status, "paid");
});
test("10.5-T2: Given the monthly example (E = 2031-08-13), then `estimate_cents = 11400`; given no insurer funds by 2031-09-22, then a corporate advance of $114.00 is posted and the borrower is paid by 2031-09-27; when the insurer's $114.00 arrives 2031-10-02, then the advance is reversed.", async () => {
  assert.equal(unearnedEstimate({ kind: "monthly", premium_cents: 19000n, coverage_month_start: D("2031-08-01") }, D("2031-08-13")), 11400n);
  const c = refundClocks(D("2031-08-13"), D("2031-08-14")); assert.equal(c.advance_if_unfunded_by, D("2031-09-22")); assert.equal(c.borrower_refund_due, D("2031-09-27"));
  const h = harness("2031-08-13T15:00:00.000Z", "L-52");
  // borrower cancellation through 10.1: the written request, an `eligible` evaluation on record (worked-loan values, clean history), then the cancel effective E = 2031-08-13
  await h.run("10.1", "pmi.*", { op: "request", loan_id: "L-52", received_at: "2031-08-13T15:00:00.000Z", channel: "written", basis: "original_value", requester_party_id: "B1", state: "TX", units: 1, occupancy: "principal", consummation: "2024-03-15" });
  const d = (await h.run("10.1", "pmi.*", { op: "evaluate", loan_id: "L-52", received_on: "2031-08-13", decision_on: "2031-08-13", original_value_cents: WORKED_LOAN.original_value_cents, evaluation_upb_cents: 31995095n, consummation: "2024-03-15", avm_cents: 45500000n, installments: installmentLedger(95, {}, D("2031-08-01")) })) as { result: string; effective_on: string; evaluation_id: string };
  assert.equal(d.result, "eligible"); assert.equal(d.effective_on, D("2031-08-13"));
  const cancelled = (await h.run("10.1", "pmi.*", { op: "cancel", loan_id: "L-52", evaluation: { ...d }, received_on: "2031-08-13", escrowed: true })) as { event: string; effective: string };
  assert.equal(cancelled.event, "mi.cancelled"); assert.equal(cancelled.effective, D("2031-08-13"));
  const est = (await h.run("10.5", "pmi.refund.estimate", { loan_id: "L-52", plan: "monthly", premium_cents: 19000n, coverage_month_start: "2031-08-01", effective_on: "2031-08-13", certificate: "CERT-1" })) as { refund_id: string; estimate_cents: bigint };
  assert.equal(est.estimate_cents, 11400n);
  const advance = h.latest("SM_MI_REFUND_ADVANCE_40"), refund = h.latest("HPA_4902F1_REFUND_45");
  assert.equal(advance.dueDate, D("2031-09-22")); assert.equal(refund.dueDate, D("2031-09-27"));
  // no insurer funds by day 40 → the policy clock breaches and the advance is posted (Dr corporate_advances(loan) / Cr custodial_ti_cash) and paid
  const breaches = h.timers.evaluate("2031-09-23T05:00:00.000Z");
  assert.ok(breaches.some((b) => b.def.code === "SM_MI_REFUND_ADVANCE_40")); assert.equal(advance.status, "breached"); assert.equal(refund.status, "armed");
  h.clock.set("2031-09-23T15:00:00.000Z");
  await h.run("10.5", "ledger.post", { entry_set: set("2031-09-23", "corporate advance of the unearned premium", [{ account: advanceOf("L-52"), amountCents: 11400n, ruleRef: "10.5 posting (3) advance" }, { account: TI, amountCents: -11400n, ruleRef: "10.5 posting (3) advance" }]) });
  const advanceSet = h.ctx.ledger.sets()[0]!;
  assert.equal(h.ctx.ledger.balance(advanceOf("L-52")), 11400n);
  const paid = (await h.run("10.5", "disbursements.issue", { loan_id: "L-52", amount_cents: 11400n, rail: "ach", status: "credited", issued_on: "2031-09-23", corporate_advance: true, refund_id: est.refund_id })) as { completed: boolean };
  assert.equal(paid.completed, true); assert.equal(refund.status, "satisfied"); assert.ok(refund.satisfiedAt!.slice(0, 10) <= "2031-09-27"); assert.equal(advance.status, "satisfied_late");
  assert.equal(h.rt.store.get("mi_refunds", est.refund_id)!.data.status, "advanced_paid");
  // the insurer's $114.00 arrives 2031-10-02 → recovery: the advance is reversed
  h.clock.set("2031-10-02T15:00:00.000Z");
  const m = (await h.run("10.5", "custodial.match", { amount_cents: 11400n, certificate: "CERT-1", received_on: "2031-10-02" })) as { matched: boolean };
  assert.equal(m.matched, true); assert.equal(h.rt.store.get("mi_refunds", est.refund_id)!.data.reverse_advance, true); assert.equal(h.rt.store.get("mi_refunds", est.refund_id)!.data.status, "closed");
  await h.run("10.5", "ledger.post", { entry_set: set("2031-10-02", "advance recovered on insurer receipt", [{ account: TI, amountCents: 11400n, ruleRef: "10.5 posting (3) reversal" }, { account: advanceOf("L-52"), amountCents: -11400n, ruleRef: "10.5 posting (3) reversal" }], { reversesSetId: advanceSet.id }) });
  assert.equal(h.ctx.ledger.balance(advanceOf("L-52")), 0n); assert.equal(h.ctx.ledger.sets()[1]!.reversesSetId, advanceSet.id);
  // over $5,000 the advance needs the officer
  assert.equal((await h.refused("10.5", "disbursements.issue", { loan_id: "L-52", amount_cents: 600000n, rail: "ach", corporate_advance: true })).code, "ADVANCE_OVER_5000_OFFICER");
  await h.run("10.5", "disbursements.issue", { loan_id: "L-52", amount_cents: 600000n, rail: "ach", corporate_advance: true }, OFFICER);
});
test("10.5-T3: Given an insurer amount of $1,380.00 vs estimate $1,411.73 (variance $31.73), then status `disputed`, dispute letter drafted within 5 BD, and the borrower still receives $1,411.73 by day 45 (policy: pay the higher amount when unresolved by day 40).", async () => {
  const dsp = reconcileInsurerRefund(141173n, 138000n, true);
  assert.equal(dsp.status, "disputed"); assert.equal(dsp.pay_borrower_cents, 141173n); assert.equal(dsp.variance_cents, -3173n);
  assert.equal(reconcileInsurerRefund(141173n, 138000n, false).pay_borrower_cents, 138000n, "before day 40 the insurer's figure is paid on time and the difference pursued");
  const h = harness("2031-08-01T05:30:00.000Z", "L-53");
  await terminate(h, "2031-08-01");
  const est = (await h.run("10.5", "pmi.refund.estimate", { loan_id: "L-53", plan: "annual", premium_cents: 228000n, anniversary_start: "2031-03-15", effective_on: "2031-08-01", certificate: "CERT-1" })) as { refund_id: string };
  h.clock.set("2031-08-12T15:00:00.000Z");
  const m = (await h.run("10.5", "custodial.match", { amount_cents: 138000n, certificate: "CERT-1", received_on: "2031-08-12" })) as { matched: boolean };
  assert.equal(m.matched, true);
  const row = h.rt.store.get("mi_refunds", est.refund_id)!.data; assert.equal(row.status, "disputed"); assert.equal(row.variance_cents, -3173n);
  const v = h.latest("SM_MI_REFUND_VARIANCE_5BD"); assert.equal(v.dueDate, addBusinessDays(D("2031-08-12"), 5, servicer)); assert.equal(v.status, "armed");
  // unresolved at day 40 → pay the higher amount by day 45
  h.clock.set("2031-09-11T15:00:00.000Z");
  const paid = (await h.run("10.5", "disbursements.issue", { loan_id: "L-53", amount_cents: reconcileInsurerRefund(141173n, 138000n, true).pay_borrower_cents, rail: "ach", status: "credited", issued_on: "2031-09-11", refund_id: est.refund_id })) as { completed: boolean };
  assert.equal(paid.completed, true); assert.equal(h.events.ofType("mi.refund.paid")[0]!.payload.amount_cents, 141173n);
  const refund = h.latest("HPA_4902F1_REFUND_45"); assert.equal(refund.status, "satisfied"); assert.ok(refund.satisfiedAt!.slice(0, 10) <= "2031-09-15");
  assert.ok(h.timers.evaluate("2031-09-11T15:00:00.000Z").some((b) => b.def.code === "SM_MI_REFUND_VARIANCE_5BD"), "the 5-BD dispute clock breached (officer sev-3)");
  await h.run("10.5", "mi_insurer.refund_status", { op: "resolve_variance", loan_id: "L-53", refund_id: est.refund_id, resolution: "corporate_absorbed", corporate_expense_cents: 3173n });
  assert.equal(v.status, "satisfied_late"); assert.equal(h.events.ofType("mi.refund.variance_resolved")[0]!.payload.corporate_expense_cents, 3173n);
});
test("10.5-T4: Given the escrow MI line balance $950.00 at E, then an interim analysis completes within 10 BD, the surplus is refunded within 30 days of the analysis, and the new payment excludes the $190.00 MI deposit effective 2031-09-01.", () => {
  const r = escrowMiLineRelease({ E: D("2031-08-01"), mi_line_balance_cents: 95000n, monthly_mi_deposit_cents: 19000n, old_payment_cents: 289186n, analysis_on: D("2031-08-06") });
  assert.equal(r.interim_analysis_due, D("2031-08-15")); assert.equal(r.surplus_cents, 95000n); assert.equal(r.surplus_refund_due, D("2031-09-05"));
  assert.equal(r.new_payment_cents, 270186n); assert.equal(r.new_payment_effective, D("2031-09-01")); assert.equal(r.refund_regardless_of_50_threshold, true);
});
test("10.5-T5: Given an LPMI policy terminated by payoff, then no borrower refund leg exists and the insurer refund posts to corporate accounts.", async () => {
  assert.deepEqual(refundLegs("lpmi"), ["corporate_income"]); assert.deepEqual(refundLegs("bpmi_annual"), ["insurer_unearned", "escrow_mi_line"]);
  const h = harness("2031-08-13T15:00:00.000Z", "L-55");
  assert.equal((await h.refused("10.5", "disbursements.issue", { loan_id: "L-55", plan: "lpmi", amount_cents: 11400n, rail: "ach" })).code, "LPMI_NEVER_TO_BORROWER");
  // the insurer's refund is a corporate receipt (Dr corporate cash / Cr corporate MI expense), outside the custodial accounts and never a borrower disbursement
  await h.run("10.5", "ledger.post", { entry_set: set("2031-08-13", "LPMI insurer refund — corporate receipt", [{ account: { scope: "corporate", account: "corporate_cash" }, amountCents: 11400n, ruleRef: "10.5 posting (4) LPMI" }, { account: { scope: "corporate", account: "advance_receivable" }, amountCents: -11400n, ruleRef: "10.5 posting (4) LPMI" }]) });
  assert.equal(h.ctx.ledger.sets()[0]!.lines.every((l) => l.account.scope === "corporate"), true);
  const r = (await h.run("10.5", "disbursements.issue", { loan_id: "L-55", plan: "lpmi", amount_cents: 11400n, rail: "ach", payee: "corporate", status: "credited" })) as { completed: boolean };
  assert.equal(r.completed, true); assert.equal(h.events.ofType("mi.refund.paid").length, 0, "no borrower refund leg");
  // the guardrail reads the policy of record: an LPMI plan on `mi_policies` refuses a borrower payee even when the command omits `plan`
  h.rt.store.put("mi_policies", "L-55", { status: "terminated", premium_plan: "lpmi_monthly", termination_type: "payoff" }, PMI_AGENT, h.clock.now());
  const before = h.seq();
  assert.equal((await h.refused("10.5", "disbursements.issue", { loan_id: "L-55", amount_cents: 11400n, rail: "ach", status: "credited" })).code, "LPMI_NEVER_TO_BORROWER");
  assert.deepEqual(h.since(before).map((x) => [x.type, x.payload.code]), [["command.refused", "LPMI_NEVER_TO_BORROWER"]]); assert.equal(h.events.ofType("mi.refund.paid").length, 0); assert.equal(h.rt.store.list("disbursements").length, 1);
  assert.equal(((await h.run("10.5", "disbursements.issue", { loan_id: "L-55", amount_cents: 11400n, rail: "ach", payee: "corporate", status: "credited" })) as { completed: boolean }).completed, true, "the corporate receipt still posts");
});
test("10.5-T6: Given the cancellation notice reaches the insurer 50 days after E, then the insurer's 45-day look-back shortfall (5 days of premium) is posted to corporate expense and the borrower receives the full unearned amount.", async () => {
  const daily = Decimal.ratio(228000n, 365n);
  assert.equal(lookbackShortfall(D("2031-08-01"), D("2031-09-20"), 45, daily), 3123n);   // 5 days × $6.2466
  const h = harness("2031-08-01T05:30:00.000Z", "L-56");
  await terminate(h, "2031-08-01");
  const est = (await h.run("10.5", "pmi.refund.estimate", { loan_id: "L-56", plan: "annual", premium_cents: 228000n, anniversary_start: "2031-03-15", effective_on: "2031-08-01", certificate: "CERT-1" })) as { refund_id: string };
  // the insurer is notified 50 days after E: the 2-BD policy target breached long before
  h.clock.set("2031-09-20T15:00:00.000Z");
  assert.ok(h.timers.evaluate("2031-09-20T15:00:00.000Z").some((b) => b.def.code === "SM_MI_INSURER_CANCEL_TARGET_2BD")); assert.equal(h.latest("SM_MI_INSURER_CANCEL_TARGET_2BD").dueDate, D("2031-08-05"));
  await h.run("10.2", "mi_insurer.cancel", { loan_id: "L-56", certificate: "CERT-1", effective_on: "2031-08-01", notified_on: "2031-09-20", reason: "automatic_78" });
  assert.equal(h.latest("SM_MI_INSURER_CANCEL_TARGET_2BD").status, "satisfied_late");
  // the insurer refunds only from 2031-08-06: $1,411.73 − $31.23; the shortfall is corporate expense and the borrower is made whole
  h.clock.set("2031-09-24T15:00:00.000Z");
  await h.run("10.5", "custodial.match", { amount_cents: 141173n - 3123n, certificate: "CERT-1", received_on: "2031-09-24", refund_id: est.refund_id });
  await h.run("10.5", "ledger.post", { entry_set: set("2031-09-24", "MGIC 45-day look-back shortfall — corporate expense", [{ account: TI, amountCents: 3123n, ruleRef: "10.5 R4 look-back shortfall" }, { account: { scope: "corporate", account: "corporate_cash" }, amountCents: -3123n, ruleRef: "10.5 R4 look-back shortfall" }]) });
  assert.equal(h.ctx.ledger.balance({ scope: "corporate", account: "corporate_cash" }), -3123n);
  await h.run("10.5", "disbursements.issue", { loan_id: "L-56", amount_cents: 141173n, rail: "ach", status: "credited", issued_on: "2031-09-24", refund_id: est.refund_id });
  assert.equal(h.events.ofType("mi.refund.paid")[0]!.payload.amount_cents, 141173n); assert.equal(h.latest("HPA_4902F1_REFUND_45").status, "satisfied_late");
});
test("10.5-T7: Given an agent command to apply the refund to late charges without a borrower election, then the command is rejected and logged.", async () => {
  assert.equal(refundApplicationAllowed("late_charges", null, D("2031-08-13")), false); assert.ok(refundApplicationAllowed("late_charges", D("2031-08-20"), D("2031-08-13")));
  const h = harness("2031-08-20T15:00:00.000Z", "L-57");
  const before = h.seq();
  const e = await h.refused("10.5", "disbursements.issue", { loan_id: "L-57", amount_cents: 11400n, rail: "ach", target: "late_charges", effective_on: "2031-08-13" });
  assert.equal(e.code, "NO_OFFSET_WITHOUT_ELECTION");
  assert.deepEqual(h.since(before).map((x) => [x.type, x.payload.code]), [["command.refused", "NO_OFFSET_WITHOUT_ELECTION"]]); assert.equal(h.ctx.decisions.length, 0);
  assert.equal((await h.refused("10.5", "disbursements.issue", { loan_id: "L-57", amount_cents: 11400n, rail: "ach", target: "late_charges", effective_on: "2031-08-13", election_signed_on: "2031-08-10" })).code, "NO_OFFSET_WITHOUT_ELECTION", "an election signed before E does not count");
  await h.run("10.5", "disbursements.issue", { loan_id: "L-57", amount_cents: 11400n, rail: "ach", target: "late_charges", effective_on: "2031-08-13", election_signed_on: "2031-08-20" });
});
test("10.5-T8: Given a borrower ACH credit returned R03, then a check is issued within 5 BD and the 45-day timer is satisfied only on the check's mailing date.", async () => {
  assert.equal(returnedAchCheckDue(D("2031-08-15")), D("2031-08-22"));
  const h = harness("2031-08-01T05:30:00.000Z", "L-58");
  await terminate(h, "2031-08-01");
  const refund = h.latest("HPA_4902F1_REFUND_45");
  h.clock.set("2031-08-13T15:00:00.000Z");
  const ach = (await h.run("10.5", "disbursements.issue", { loan_id: "L-58", amount_cents: 141173n, rail: "ach", issued_on: "2031-08-13" })) as { disbursement_id: string; completed: boolean };
  assert.equal(ach.completed, false); assert.equal(refund.status, "armed", "a submitted ACH is not a completed refund");
  h.clock.set("2031-08-20T15:00:00.000Z");
  const check = (await h.run("10.5", "disbursements.issue", { loan_id: "L-58", amount_cents: 141173n, rail: "check", reissue_of: ach.disbursement_id, return_code: "R03", returned_on: "2031-08-15", mailed_on: "2031-08-20" })) as { completed: boolean; refund_paid_on: string; satisfies_45_day_timer_on: string };
  assert.equal(h.events.ofType("disbursement.returned")[0]!.payload.check_due_by, D("2031-08-22"));
  assert.equal(check.completed, true); assert.equal(check.refund_paid_on, D("2031-08-20")); assert.equal(check.satisfies_45_day_timer_on, "mailing date");
  assert.equal(refund.status, "satisfied"); assert.equal(refund.satisfiedAt!.slice(0, 10), "2031-08-20"); assert.equal(h.events.ofType("mi.refund.paid")[0]!.payload.paid_on, D("2031-08-20"));
});
test("10.5-T9: Given Dec. 2, 2026 or later, then the refund deposit and disbursement generate escrow events accepted before 03:00 ET the next business day.", async () => {
  const r = refundEscrowEvents({ posted_on: D("2026-12-02"), legs: [{ kind: "deposit", amount_cents: 141173n }, { kind: "disbursement", amount_cents: 141173n }] });
  assert.equal(r.events.length, 2); assert.equal(r.accept_by_ms, zonedEpochMs(D("2026-12-03"), "03:00", ET));
  assert.ok(r.events.every((e) => e.type === "escrow.event" && e.category === "taxes_insurance" && e.accept_by_ms === r.accept_by_ms));
  assert.ok(zonedEpochMs(D("2026-12-03"), "02:59", ET) < r.accept_by_ms!);
  assert.deepEqual(refundEscrowEvents({ posted_on: D("2026-11-30"), legs: [{ kind: "deposit", amount_cents: 1n }] }).events, []);
  // Through the bus: the $1,411.73 insurer deposit matched and the borrower disbursement credited on Wed 2026-12-02 each publish
  // `mi.refund.posted{escrow_event=true}` → one LL_2026_05_ESCROW_EVENT_3AM instance per leg, due Thu 2026-12-03 03:00 ET.
  const h = harness("2026-12-02T15:00:00.000Z", "L-59");
  const est = (await h.run("10.5", "pmi.refund.estimate", { loan_id: "L-59", plan: "annual", premium_cents: 228000n, anniversary_start: "2026-07-04", effective_on: "2026-11-20", certificate: "CERT-1" })) as { refund_id: string; estimate_cents: bigint };
  assert.equal(est.estimate_cents, 141173n);   // 139 days in force, as in the worked example
  await h.run("10.5", "custodial.match", { amount_cents: 141173n, certificate: "CERT-1", received_on: "2026-12-02" });
  const dep = h.timer("LL_2026_05_ESCROW_EVENT_3AM"); assert.equal(dep.length, 1); assert.equal(dep[0]!.status, "armed");
  assert.equal(dep[0]!.dueAt, zonedEpochMs(D("2026-12-03"), "03:00", ET)); assert.equal(dep[0]!.dueDate, D("2026-12-03")); assert.equal(dep[0]!.anchorDate, D("2026-12-02"));
  await h.run("10.5", "disbursements.issue", { loan_id: "L-59", amount_cents: 141173n, rail: "ach", status: "credited", issued_on: "2026-12-02", refund_id: est.refund_id });
  assert.deepEqual(h.events.ofType("mi.refund.posted").map((e) => [e.payload.leg, e.payload.escrow_event, e.payload.accept_by_ms]), [["deposit", true, r.accept_by_ms], ["disbursement", true, r.accept_by_ms]]);
  assert.equal(h.timer("LL_2026_05_ESCROW_EVENT_3AM").length, 2);
  // the legs are submitted as Taxes & Insurance escrow events (signed amount, balance after, sequence — §3.7 rule 11) carrying the 03:00 ET deadline
  const s1 = (await h.run("10.5", "ledger.post", { op: "escrow_event", loan_id: "L-59", kind: "deposit", amount_cents: 141173n, posted_on: "2026-12-02", balance_cents: 141173n, refund_id: est.refund_id })) as { investor_event_id: string; escrow_event: boolean; accept_by_ms: number; sequence: number };
  const s2 = (await h.run("10.5", "ledger.post", { op: "escrow_event", loan_id: "L-59", kind: "disbursement", amount_cents: 141173n, posted_on: "2026-12-02", balance_cents: 0n, refund_id: est.refund_id })) as { investor_event_id: string; escrow_event: boolean; accept_by_ms: number; sequence: number };
  assert.equal(s1.escrow_event, true); assert.equal(s1.accept_by_ms, r.accept_by_ms); assert.deepEqual([s1.sequence, s2.sequence], [1, 2]);
  assert.deepEqual(h.events.ofType("escrow.event.submitted").map((e) => [e.payload.kind, e.payload.amount_cents, e.payload.balance_cents, e.payload.category]), [["deposit", 141173n, 141173n, "taxes_insurance"], ["disbursement", -141173n, 0n, "taxes_insurance"]]);
  assert.equal(h.rt.store.get("investor_events", s1.investor_event_id)!.data.status, "submitted");
  // a tampered or malformed acknowledgement is refused before anything is appended: wrong loan, unknown event, bad status, no instant
  const before = h.seq();
  await assert.rejects(h.run("10.5", "ledger.post", { op: "escrow_event_ack", ack: { investor_event_id: s1.investor_event_id, loan_id: "L-99", status: "accepted", acked_at: "2026-12-03T01:00:00.000Z" } }), RangeError);
  await assert.rejects(h.run("10.5", "ledger.post", { op: "escrow_event_ack", ack: { investor_event_id: "esc-L-59-9", loan_id: "L-59", status: "accepted", acked_at: "2026-12-03T01:00:00.000Z" } }), RangeError);
  await assert.rejects(h.run("10.5", "ledger.post", { op: "escrow_event_ack", ack: { investor_event_id: s1.investor_event_id, loan_id: "L-59", status: "ok", acked_at: "2026-12-03T01:00:00.000Z" } }), RangeError);
  await assert.rejects(h.run("10.5", "ledger.post", { op: "escrow_event_ack", ack: { investor_event_id: s1.investor_event_id, loan_id: "L-59", status: "accepted", acked_at: "yesterday" } }), RangeError);
  await assert.rejects(h.run("10.5", "ledger.post", { op: "escrow_event_ack" }), RangeError);
  assert.equal(h.since(before).filter((e) => e.type.startsWith("escrow.event.")).length, 0); assert.equal(h.timer("LL_2026_05_ESCROW_EVENT_3AM").every((t) => t.status === "armed"), true);
  // Fannie Mae acknowledges at 20:00 ET Dec. 2 (01:00Z Dec. 3, before 03:00 ET): `escrow.event.accepted` satisfies the clock on time
  h.clock.set("2026-12-03T01:00:00.000Z");
  const a1 = (await h.run("10.5", "ledger.post", { op: "escrow_event_ack", ack: { investor_event_id: s1.investor_event_id, loan_id: "L-59", status: "accepted", acked_at: "2026-12-03T01:00:00.000Z" } })) as { status: string; on_time: boolean };
  assert.deepEqual([a1.status, a1.on_time], ["accepted", true]);
  const accepted = h.events.ofType("escrow.event.accepted"); assert.equal(accepted.length, 1);
  assert.deepEqual([accepted[0]!.payload.investor_event_id, accepted[0]!.payload.status, accepted[0]!.payload.kind, accepted[0]!.payload.amount_cents, accepted[0]!.payload.on_time], [s1.investor_event_id, "accepted", "deposit", 141173n, true]);
  assert.ok(accepted[0]!.occurredAt.startsWith("2026-12-03T01:00")); assert.ok(Date.parse(accepted[0]!.occurredAt) < r.accept_by_ms!);
  assert.equal(h.timer("LL_2026_05_ESCROW_EVENT_3AM").every((t) => t.status === "satisfied" && t.satisfiedByEventId === accepted[0]!.id), true);
  assert.equal(h.events.ofType("timer.satisfied").filter((e) => e.payload.code === "LL_2026_05_ESCROW_EVENT_3AM" && e.payload.late === false).length, 2);
  assert.equal(h.rt.store.get("investor_events", s1.investor_event_id)!.data.status, "accepted");
  const a2 = (await h.run("10.5", "ledger.post", { op: "escrow_event_ack", ack: { investor_event_id: s2.investor_event_id, loan_id: "L-59", status: "accepted_warning", acked_at: "2026-12-03T01:00:00.000Z", warnings: ["W-1"] } })) as { status: string; on_time: boolean };
  assert.deepEqual([a2.status, a2.on_time], ["accepted_warning", true]); assert.deepEqual(h.events.ofType("escrow.event.accepted")[1]!.payload.warnings, ["W-1"]);
  await assert.rejects(h.run("10.5", "ledger.post", { op: "escrow_event_ack", ack: { investor_event_id: s1.investor_event_id, loan_id: "L-59", status: "accepted", acked_at: "2026-12-03T02:00:00.000Z" } }), RangeError, "a duplicate ack is refused");
  assert.equal(h.timers.evaluate("2026-12-03T08:00:01.000Z").filter((b) => b.def.code === "LL_2026_05_ESCROW_EVENT_3AM").length, 0);
  // an ack after 03:00 ET: the clock breached and is only satisfied late; a rejection routes to the 3.7 correction path and satisfies nothing
  const late = harness("2026-12-04T15:00:00.000Z", "L-61");
  await late.run("10.5", "disbursements.issue", { loan_id: "L-61", amount_cents: 11400n, rail: "ach", status: "credited", issued_on: "2026-12-04" });
  assert.equal(late.latest("LL_2026_05_ESCROW_EVENT_3AM").dueAt, zonedEpochMs(D("2026-12-07"), "03:00", ET), "Fri → next Fannie business day Mon 2026-12-07");
  const s3 = (await late.run("10.5", "ledger.post", { op: "escrow_event", loan_id: "L-61", kind: "disbursement", amount_cents: 11400n, posted_on: "2026-12-04", balance_cents: 0n })) as { investor_event_id: string };
  late.clock.set("2026-12-07T09:00:00.000Z");
  assert.ok(late.timers.evaluate("2026-12-07T08:00:01.000Z").some((b) => b.def.code === "LL_2026_05_ESCROW_EVENT_3AM")); assert.equal(late.latest("LL_2026_05_ESCROW_EVENT_3AM").status, "breached");
  const rej = (await late.run("10.5", "ledger.post", { op: "escrow_event_ack", ack: { investor_event_id: s3.investor_event_id, loan_id: "L-61", status: "rejected", acked_at: "2026-12-07T09:00:00.000Z", reject_reason: "balance mismatch" } })) as { status: string };
  assert.equal(rej.status, "rejected"); assert.equal(late.events.ofType("escrow.event.rejected")[0]!.payload.reject_reason, "balance mismatch"); assert.equal(late.latest("LL_2026_05_ESCROW_EVENT_3AM").status, "breached");
  const a3 = (await late.run("10.5", "ledger.post", { op: "escrow_event_ack", ack: { investor_event_id: s3.investor_event_id, loan_id: "L-61", status: "accepted", acked_at: "2026-12-07T10:00:00.000Z" } })) as { on_time: boolean };
  assert.equal(a3.on_time, false); assert.equal(late.latest("LL_2026_05_ESCROW_EVENT_3AM").status, "satisfied_late");
  // before Dec. 1, 2026 nothing is reported and no clock arms (Form 496A captures the flows)
  const pre = harness("2026-11-30T15:00:00.000Z", "L-60");
  await pre.run("10.5", "disbursements.issue", { loan_id: "L-60", amount_cents: 11400n, rail: "ach", status: "credited", issued_on: "2026-11-30" });
  assert.equal(pre.events.ofType("mi.refund.posted")[0]!.payload.escrow_event, false); assert.equal(pre.timer("LL_2026_05_ESCROW_EVENT_3AM").length, 0);
  const none = (await pre.run("10.5", "ledger.post", { op: "escrow_event", loan_id: "L-60", kind: "disbursement", amount_cents: 11400n, posted_on: "2026-11-30" })) as { escrow_event: boolean; reason: string | null };
  assert.equal(none.escrow_event, false); assert.match(none.reason!, /2026-12-01/); assert.equal(pre.events.ofType("escrow.event.submitted").length, 0);
});
test("10.5-T10: Given an insurer rescission notice received 2027-03-03, then LAR 89 action code 54 with action date 030327 is reported and a Fannie Mae notification is made within 30 days; the borrower refund leg is held for `officer` decision.", () => {
  const r = insurerRescission({ received_on: D("2027-03-03"), loan_active: true });
  assert.deepEqual(r.lar89, { code: "54", action_date: "030327", line_suffix: "54 030327" }); assert.deepEqual(r.fnma_notification, { due: D("2027-04-02"), channel: "lar89" });
  assert.deepEqual(r.borrower_refund_leg, { status: "held", decision_by: "officer", borrower_entitled_unless: "borrower misrepresentation" }); assert.equal(r.hpa_termination_notice, false); assert.equal(r.informational_letter, true);
  assert.equal(insurerRescission({ received_on: D("2027-03-03"), loan_active: false }).fnma_notification.channel, "email_liquidated");
});

test("10.5 worked figures: annual earned $868.27 of $2,280.00; monthly earned $76.00, unearned $114.00; MI line $950.00; payment $2,891.86 → $2,701.86", () => {
  assert.equal(228000n - unearnedEstimate({ kind: "annual", premium_cents: 228000n, anniversary_start: D("2031-03-15") }, D("2031-08-01")), 86827n);
  const monthly = unearnedEstimate({ kind: "monthly", premium_cents: 19000n, coverage_month_start: D("2031-08-01") }, D("2031-08-13"));
  assert.equal(monthly, 11400n); assert.equal(19000n - monthly, 7600n);
  assert.equal(escrowMiLineRelease({ E: D("2031-08-01"), mi_line_balance_cents: 95000n, monthly_mi_deposit_cents: 19000n, old_payment_cents: 289186n }).new_payment_cents, 270186n);
});
