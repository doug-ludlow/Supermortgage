/** §11.1–11.5 acceptance tests. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { zonedEpochMs, toIso } from "../../kernel/calendar/zoned.ts";
import { cents } from "../../kernel/money/cents.ts";
import { openWindow, installmentPaid, applyContact, sweep, noticeCycle, nextNoticeDue, printHandoffDue, bkModifiedNoticeDue, transfereeFirstNoticeDue, variantFor, cadence, liveDueMs } from "./windows.ts";
import { qrpcCompleteness, reasonCode, promiseToPay, promiseOutcome, isStale, thirdPartyAuthorization } from "./qrpc.ts";
import * as F from "./fdcpa.ts";
import * as ID from "./imminent-default.ts";
import { applyFifo, regxDaysDelinquent } from "../boarding/delinquency.ts";

test("11.1-T1/T2: Nov 1 window (CT) — live 12-07 23:59 CT, notice 12-16; FIFO partials leave the live leg standing and cancel the notice leg; counter = 10 on 12-11", () => {
  const w = openWindow(D("2026-11-01"), { principal_residence: true });
  assert.equal(w.live_due_at, "2026-12-07"); assert.equal(w.notice_due_at, "2026-12-16");
  assert.equal(toIso(liveDueMs(w, "America/Chicago")), toIso(zonedEpochMs(D("2026-12-07"), "23:59", "America/Chicago")));
  const P = cents("2000");
  const r = applyFifo([{ due_date: D("2026-11-01"), amount_cents: P }, { due_date: D("2026-12-01"), amount_cents: P }], [{ received_on: D("2026-11-20"), amount_cents: cents("1200") }, { received_on: D("2026-12-10"), amount_cents: cents("1200") }]);
  installmentPaid(w, r.installments[0]!.satisfied_on!);
  assert.equal(w.live, "open"); assert.equal(w.notice, "cancelled_paid");
  assert.equal(regxDaysDelinquent(r.installments, D("2026-12-11")), 10);
  const w2 = openWindow(D("2026-12-01"), { principal_residence: true }); assert.equal(w2.live_due_at, "2027-01-06"); assert.equal(w2.notice_due_at, "2027-01-15");
  // paid on Dec 5 would have cancelled both legs
  const w3 = openWindow(D("2026-11-01"), { principal_residence: true }); installmentPaid(w3, D("2026-12-05")); assert.equal(w3.live, "cancelled_paid"); assert.equal(w3.notice, "cancelled_paid");
});

test("11.1-T3/T4/T6/T7: rolling delinquency never breaches; one contact satisfies all open windows containing it; breach sweep; bankruptcy exemption; cadence", () => {
  const ws = [D("2027-01-01"), D("2027-02-01"), D("2027-03-01")].map((d) => openWindow(d, { principal_residence: true }));
  for (const w of ws.slice(0, 2)) installmentPaid(w, w.due_date === "2027-01-01" ? D("2027-02-01") : D("2027-03-01"));
  assert.equal(ws[0]!.live, "cancelled_paid"); assert.equal(ws[1]!.live, "cancelled_paid");
  const fresh = [D("2027-01-01"), D("2027-02-01"), D("2027-03-01")].map((d) => openWindow(d, { principal_residence: true }));
  const hit = applyContact(fresh, D("2027-02-05"), "live", "ai_voice"); assert.equal(hit.length, 2); assert.equal(fresh[2]!.live, "open");
  assert.equal(sweep(fresh, D("2027-04-07")).length, 3);   // Mar 1 live leg (Apr 6) + Jan/Feb notice legs (Feb 15, Mar 18); Mar notice (Apr 15) still open
  const bk = openWindow(D("2027-01-01"), { principal_residence: true, bankruptcy: "active" }); assert.equal(bk.live, "exempt_bk");
  assert.equal(openWindow(D("2027-01-01"), { principal_residence: false }).notice, "exempt_investment");
  assert.deepEqual(cadence(10, { consent_voice: true }), { attempt: false, channel: null, reason: "grace/pre-day-17" });
  assert.equal(cadence(17, { consent_voice: true }).channel, "ai_voice"); assert.equal(cadence(17, { consent_voice: false }).reason, "TCPA_64_1200_A1_CELL_CONSENT_GATE");
  assert.equal(cadence(40, { consent_voice: true, suspended: "bankruptcy" }).attempt, false);
});

test("11.2-T1..T8: notice due/handoff, 180-day cycle repeats, fdcpa 190, bk modified notice, transferee rule", () => {
  const w = openWindow(D("2026-11-01"), { principal_residence: true }); assert.equal(printHandoffDue(w.notice_due_at), "2026-12-14");
  const c = noticeCycle(D("2026-12-14"), "standard", "cyc-1"); assert.equal(c.cycle_end_at, "2027-06-12");
  assert.equal(openWindow(D("2026-12-01"), { principal_residence: true, active_cycle: c }).notice, "satisfied_by_prior_180");
  assert.deepEqual(nextNoticeDue(c, 60, D("2026-11-01")), { due_on: "2027-06-12", scheduled_on: "2027-06-10" });
  assert.equal(nextNoticeDue(c, 20, D("2027-06-01")).due_on, "2027-07-16");
  const f = noticeCycle(D("2026-12-14"), "fdcpa", "cyc-2"); assert.equal(f.cycle_end_at, "2027-06-22"); assert.equal(nextNoticeDue(f, 60, null).due_on, "2027-06-22");
  assert.equal(bkModifiedNoticeDue(D("2027-01-20"), false), "2027-03-06"); assert.equal(bkModifiedNoticeDue(D("2027-01-20"), true), null);
  assert.equal(transfereeFirstNoticeDue(D("2026-05-01")), "2026-06-15");
  assert.equal(openWindow(D("2026-05-01"), { principal_residence: true, transferor_notice_within_45: true }).notice, "deferred_transferee");
  assert.equal(variantFor({ bk_active: false, debt_collector: true, cease_active: true }), "fdcpa"); assert.equal(variantFor({ bk_active: true, debt_collector: true, cease_active: true }), "bk");
});

test("11.3-T1/T2/T3/T4/T9/T12: completeness, reason codes, promise-to-pay $4,165 by 12-28, partial, staleness, 90-day oral authorization", () => {
  const full = { verified_party: "borrower" as const, reason_primary: "unemployment", hardship_nature: "lost job in October", occupancy_status: "principal", ability_to_pay: { commitment_kind: "promise" }, options_explained: ["repayment_plan"], commitment_kind: "promise_to_pay" as const, payment_importance_emphasized: true };
  assert.equal(qrpcCompleteness(full).complete, true);
  assert.deepEqual(qrpcCompleteness({ verified_party: "borrower", reason_primary: "unemployment", occupancy_status: "principal" }).missing, ["ability_to_pay", "options", "commitment", "payment_importance"]);
  assert.equal(qrpcCompleteness({ ...full, options_explained: null, options_not_appropriate_reason: "full_payment_promised" }).complete, true);
  assert.equal(qrpcCompleteness({ ...full, commitment_kind: "callback_only" }).complete, false);
  assert.equal(reasonCode("unemployment"), "016"); assert.equal(reasonCode("reduction_in_income"), "006"); assert.equal(reasonCode("declined"), "015");
  const total = 2n * cents("2000") + 2n * cents("82.50"); assert.equal(total, cents("4165"));
  assert.deepEqual(promiseToPay(cents("4165"), D("2026-12-28"), D("2026-12-11"), total), { valid: true, covers: "full", within_30: true, plan: "ceased{ptp_pending}" });
  const partial = promiseToPay(cents("2000"), D("2026-12-28"), D("2026-12-11"), total); assert.equal(partial.covers, "partial"); assert.equal(partial.next_attempt_on, "2026-12-29");
  assert.equal(promiseToPay(cents("4165"), D("2027-01-15"), D("2026-12-11"), total).valid, false);
  assert.equal(promiseOutcome(cents("2000"), cents("4165")), "partial");
  assert.equal(isStale(D("2026-12-11"), D("2027-01-10"), false), false); assert.equal(isStale(D("2026-12-11"), D("2027-01-11"), false), true);
  assert.deepEqual(thirdPartyAuthorization("oral_three_way", D("2026-12-11")), { scope: "discuss_only", expires_on: "2027-03-11" });
});

test("11.4-T1/T2/T3/T3a/T4: debt-collector determination, calendar-day validation notice, assumed receipt, itemization", () => {
  assert.deepEqual(F.determineDebtCollector({ regx_days_delinquent_at_transfer: 61, bk_active: false, fc_active: false, accelerated: false }), { debt_collector: true, basis: "default_at_obtain" });
  assert.equal(F.determineDebtCollector({ regx_days_delinquent_at_transfer: 0, bk_active: false, fc_active: false, accelerated: false }).debt_collector, false);
  assert.equal(F.determineDebtCollector({ regx_days_delinquent_at_transfer: 1, bk_active: false, fc_active: false, accelerated: false, threshold_days: 30 }).debt_collector, false);
  assert.equal(F.validationNoticeDue(D("2026-09-30")), "2026-10-05");
  assert.deepEqual(F.validationPeriod(D("2026-10-02")), { assumed_receipt_on: "2026-10-09", validation_period_end_on: "2026-11-08" });
  assert.equal(F.validationNoticeDue(D("2026-10-14")), "2026-10-19");                      // Sat/Sun count
  assert.deepEqual(F.validationPeriod(D("2026-10-19")), { assumed_receipt_on: "2026-10-26", validation_period_end_on: "2026-11-25" });
  const it = F.itemizationChecks({ itemization_date: D("2026-08-17"), amount_on_itemization_cents: 31_254_022n, interest_since_cents: 123_811n, fees_since_cents: 16_500n, payments_since_cents: 0n, credits_since_cents: 0n, current_amount_cents: 31_394_333n });
  assert.equal(it.consistent, true); assert.equal(it.sum_cents, 31_394_333n);
  assert.ok(F.overshadows("You must pay within 10 days.", D("2026-11-08"), D("2026-10-20")).length >= 1);
  assert.equal(F.overshadows("You may dispute this debt. Contact your assigned team.", D("2026-11-08"), D("2026-10-20")).length, 0);
  assert.equal(F.communicationAllowed({ dispute_open: true }, "collection_call", "outbound_collection").allowed, false);
  assert.equal(F.communicationAllowed({ cease_active: true }, "periodic_statement", "outbound_collection").allowed, true);
  assert.equal(F.communicationAllowed({ cease_active: true }, "collection_call", "borrower_initiated").allowed, true);
});

test("11.5-T1..T6: hardship path, credit path with representative score and HTI, reserves strictness, 60-day reroute, FICO age, PCS 50 miles", () => {
  const base = { evaluation_date: D("2026-10-20"), regx_days_delinquent: 0, principal_residence: true, brp_complete: true, oldest_doc_date: D("2026-09-26"), cash_reserves_cents: cents("8400"), hardship_documented: true };
  const a = ID.evaluate({ ...base, hardship_type: "death_of_borrower_or_wage_earner" }); assert.equal(a.outcome, "eligible_hardship");
  assert.deepEqual(ID.noticeDeadlines(D("2026-10-21"), D("2026-10-20")), { evaluation_notice_due: "2026-10-26", response_window_days: 14 });
  assert.equal(ID.representativeScore([601, 612, 620]), 612); assert.equal(ID.representativeScore([640, 610]), 610);
  const b = ID.evaluate({ ...base, hardship_type: "reduction_in_income", credit: { scores: [601, 612, 620], fico_date: D("2026-10-20"), delinquencies_30_in_6m: 1, pitia_cents: cents("2000"), gross_income_cents: cents("4642.72") } });
  assert.equal(b.outcome, "eligible_credit"); if (b.outcome === "eligible_credit") { assert.equal(b.tests.delinquency, false); assert.equal(b.tests.hti, true); }
  assert.equal(ID.hti(cents("2000"), cents("4642.72")).display, "0.43");
  const b2 = ID.evaluate({ ...base, hardship_type: "reduction_in_income", credit: { scores: [601, 612, 620], fico_date: D("2026-10-20"), delinquencies_30_in_6m: 1, pitia_cents: cents("2000"), gross_income_cents: cents("6031.25") } }); assert.equal(b2.outcome, "ineligible");
  assert.equal(ID.evaluate({ ...base, hardship_type: "death_of_borrower_or_wage_earner", cash_reserves_cents: cents("25000") }).outcome, "ineligible"); assert.equal(ID.evaluate({ ...base, hardship_type: "death_of_borrower_or_wage_earner", cash_reserves_cents: cents("24999.99") }).outcome, "eligible_hardship");
  assert.equal(ID.evaluate({ ...base, regx_days_delinquent: 59, hardship_type: "death_of_borrower_or_wage_earner" }).outcome, "eligible_hardship"); assert.equal(ID.evaluate({ ...base, regx_days_delinquent: 60, hardship_type: "death_of_borrower_or_wage_earner" }).outcome, "rerouted_delinquent");
  const old = ID.evaluate({ ...base, hardship_type: "reduction_in_income", credit: { scores: [600], fico_date: D("2026-07-21"), delinquencies_30_in_6m: 2, pitia_cents: 1n, gross_income_cents: 1n } }); assert.equal(old.outcome, "ineligible"); if (old.outcome === "ineligible") assert.deepEqual(old.failed, ["FNMA_D2101_FICO_AGE_90"]);
  assert.equal(ID.evaluate({ ...base, hardship_type: "distant_transfer_or_pcs_gt_50mi", pcs_distance_miles: 52.0, cash_reserves_cents: cents("40000") }).outcome, "eligible_hardship");
  assert.equal(ID.evaluate({ ...base, hardship_type: "distant_transfer_or_pcs_gt_50mi", pcs_distance_miles: 49.9 }).outcome, "ineligible");
  assert.equal(ID.solicitationGate(12, false).ok, false); assert.equal(ID.solicitationGate(12, true).ok, true);
});
