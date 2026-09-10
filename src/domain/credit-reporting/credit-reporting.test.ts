import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as d, addMonths } from "../../kernel/calendar/date.ts";
import { servicerCalendar } from "../../kernel/calendar/business.ts";
import { cents, levelPayment, ratePercent } from "../../kernel/money/cents.ts";
import { applyFifo, type AppliedInstallment } from "../boarding/delinquency.ts";
import {
  buildSnapshot, renderBase, metro2Money, statusForDays, carryPhp, phpPosition, validateSnapshot, anomalyGate, transmissionClocks,
  negativeInfoNoticeDue, correctDofd, DofdReageBlocked, handoffHistory, boardingMonthReporter, deriveDelinquency,
  type CreditLoanState, type PriorHistory, type LoanCondition, type Metro2Snapshot,
  directDisputeClocks, supplementationOpensNewCase, frivolousNoticeDue, frivolousEligible, acdvClocks, requiresHumanReview,
  cccOnReceipt, cccOnClose, correctionFanOut, AcdvSubmitGuard, preBoardingDetermination,
  resolveSuppression, applyNoeBar, noeBarEnd, bankruptcyOverlay, scraReducedPayment, scraOverlay, disasterOverlay, deceasedOverlay,
  identityTheftResponse, fdcpaGateIncludes, fdcpaGateOpensOn, sampleVerification, courtesyRequest, type Suppression,
} from "./index.ts";

// ---- SM-1001 fixture (8.1 rule 13) ------------------------------------------
const PI = cents("1847.15"), ESCROW = cents("612.40"), PITI = PI + ESCROW;
const RATE = ratePercent("6.25");

function schedule(from: string, n: number) {
  return Array.from({ length: n }, (_, i) => ({ due_date: addMonths(d(from), i), amount_cents: PITI }));
}
/** Installments 2025-03-01 … with payments through `paidThrough` (inclusive), plus extra receipts. */
function ledger(paidThrough: string, extra: { received_on: string; amount_cents: bigint }[] = []): readonly AppliedInstallment[] {
  const inst = schedule("2025-03-01", 40);
  const pays = inst.filter((i) => i.due_date <= d(paidThrough)).map((i) => ({ received_on: i.due_date, amount_cents: PITI }));
  return applyFifo(inst, [...pays, ...extra.map((e) => ({ received_on: d(e.received_on), amount_cents: e.amount_cents }))]).installments;
}
function state(asOf: string, installments: readonly AppliedInstallment[], prior: PriorHistory | Metro2Snapshot | null, over: Partial<CreditLoanState> = {}): CreditLoanState {
  return {
    loan_id: "SM-1001", as_of: d(asOf), installments, upb_cents: cents("293063.94"), deferred_principal_cents: 0n, forborne_principal_cents: 0n,
    pi_cents: PI, escrow_cents: ESCROW, original_amount_cents: cents("300000"), note_date: d("2025-02-14"), maturity_date: d("2055-02-01"),
    original_term_months: 360, remaining_term_months: 337, interest_type: "F", fnma_loan_number: "1234567890", min: "100012345678901234",
    payments_in_month_cents: PITI, last_payment_on: d("2027-01-01"), condition: { kind: "none" },
    consumers: [{ party_id: "A", position: 1, same_address_as_base: true, liability: "individual" }], prior, ...over,
  };
}
const JAN_PRIOR: PriorHistory = { php: "0000000000000000000000BB".slice(1) + "B", status: "11", dofd: null }; // Dec-2026 snapshot

test("8.1-T1 happy path: 2027-01-31 current → 11, balance 000293063, PHP 0…0BB, K3 with MIN", () => {
  // Build the Jan snapshot from a Dec snapshot whose PHP already holds 21 zeros + BBB.
  const dec: PriorHistory = { php: "0".repeat(21) + "BBB", status: "11", dofd: null };
  const s = buildSnapshot(state("2027-01-31", ledger("2027-01-01"), dec));
  const r = renderBase(s);
  assert.equal(r.account_status, "11");
  assert.equal(r.current_balance, "000293063");
  assert.equal(r.amount_past_due, "000000000");
  assert.equal(r.date_of_first_delinquency, "00000000");
  assert.equal(r.scheduled_monthly_payment, "000002459");
  assert.equal(r.payment_history_profile, "0000000000000000000000BB");
  assert.equal(s.k3.min, "100012345678901234");
  assert.deepEqual(validateSnapshot(s), []);
});

test("8.1-T2 delinquency buckets: 02-28 → 11 (27 days); 03-31 → 71 DOFD 02012027; 04-30 → 78; APD 2459/4919/7378", () => {
  const led = ledger("2027-01-01");
  const jan = buildSnapshot(state("2027-01-31", led, JAN_PRIOR));
  const feb = buildSnapshot(state("2027-02-28", led, jan, { payments_in_month_cents: 0n }));
  assert.equal(feb.days_past_due, 27);
  assert.equal(renderBase(feb).account_status, "11");
  assert.equal(renderBase(feb).amount_past_due, "000002459");
  assert.equal(renderBase(feb).date_of_first_delinquency, "00000000");
  assert.equal(feb.php[0], "0");
  const mar = buildSnapshot(state("2027-03-31", led, feb));
  assert.equal(mar.days_past_due, 58);
  assert.equal(mar.account_status, "71");
  assert.equal(renderBase(mar).date_of_first_delinquency, "02012027");
  assert.equal(renderBase(mar).amount_past_due, "000004919");
  assert.equal(mar.php[0], "0");
  const apr = buildSnapshot(state("2027-04-30", led, mar));
  assert.equal(apr.days_past_due, 88);
  assert.equal(apr.account_status, "78");
  assert.equal(renderBase(apr).amount_past_due, "000007378");
  assert.equal(apr.php.slice(0, 3), "100");
  assert.equal(apr.dofd, d("2027-02-01"));
});

function aprSnapshot(): Metro2Snapshot {
  const led = ledger("2027-01-01");
  const jan = buildSnapshot(state("2027-01-31", led, JAN_PRIOR));
  const feb = buildSnapshot(state("2027-02-28", led, jan));
  const mar = buildSnapshot(state("2027-03-31", led, feb));
  return buildSnapshot(state("2027-04-30", led, mar));
}

test("8.1-T3 forbearance freeze: 05-31…07-31 report 78 + CP frozen; contractual_aging policy → 80/82/84 and PHP 43210…", () => {
  const led = ledger("2027-01-01");
  const fb: LoanCondition = { kind: "forbearance", effective_on: d("2027-05-01"), entry_status: "78", entry_amount_past_due_cents: cents("7378.65"), plan_payment_cents: 0n };
  let prior: Metro2Snapshot = aprSnapshot();
  const frozen: Metro2Snapshot[] = [];
  for (const m of ["2027-05-31", "2027-06-30", "2027-07-31"]) {
    prior = buildSnapshot(state(m, led, prior, { condition: fb, payments_in_month_cents: 0n }));
    frozen.push(prior);
  }
  for (const s of frozen) {
    assert.equal(s.account_status, "78");
    assert.equal(s.special_comment, "CP");
    assert.equal(renderBase(s).amount_past_due, "000007378");
    assert.equal(renderBase(s).scheduled_monthly_payment, "000000000");
    assert.equal(renderBase(s).date_of_first_delinquency, "02012027");
  }
  assert.equal(frozen[2]!.php.slice(0, 6), "222100");
  // Alternative policy
  const aging = { metro2_rounding: "truncate", forbearance_status: "contractual_aging", terms_duration: "original" } as const;
  let p2: Metro2Snapshot = aprSnapshot();
  const statuses: string[] = [];
  for (const m of ["2027-05-31", "2027-06-30", "2027-07-31"]) {
    p2 = buildSnapshot(state(m, led, p2, { condition: fb }), aging);
    statuses.push(p2.account_status);
  }
  assert.deepEqual(statuses, ["80", "82", "84"]);
  assert.equal(p2.php.slice(0, 5), "43210");
});

function julySnapshot(): Metro2Snapshot {
  const led = ledger("2027-01-01");
  const fb: LoanCondition = { kind: "forbearance", effective_on: d("2027-05-01"), entry_status: "78", entry_amount_past_due_cents: cents("7378.65"), plan_payment_cents: 0n };
  let prior: Metro2Snapshot = aprSnapshot();
  for (const m of ["2027-05-31", "2027-06-30", "2027-07-31"]) prior = buildSnapshot(state(m, led, prior, { condition: fb }));
  return prior;
}

test("8.1-T4 deferral cure: 08-31 → 11, balance 000307500, K4 01/02012055/000014757, DOFD zero, PHP 222210…", () => {
  // Deferral moves Feb–Jul to non-interest-bearing; the ledger shows them satisfied on the deferral date and Aug paid 08-10.
  const inst = schedule("2025-03-01", 40);
  const pays = inst.filter((i) => i.due_date <= d("2027-01-01")).map((i) => ({ due: i.due_date, on: i.due_date }));
  const led = applyFifo(inst, [
    ...pays.map((p) => ({ received_on: p.on, amount_cents: PITI })),
    { received_on: d("2027-08-10"), amount_cents: PITI },                      // Aug installment (applied FIFO to Feb …)
    { received_on: d("2027-08-15"), amount_cents: PITI * 6n },                 // deferral: Feb–Jul satisfied by deferral, not cash
  ]).installments;
  const s = buildSnapshot(state("2027-08-31", led, julySnapshot(), {
    upb_cents: cents("292743.16"), deferred_principal_cents: cents("14757.30"), condition: { kind: "deferral" }, last_payment_on: d("2027-08-10"),
  }));
  const r = renderBase(s);
  assert.equal(r.account_status, "11");
  assert.equal(r.amount_past_due, "000000000");
  assert.equal(r.date_of_first_delinquency, "00000000");
  assert.equal(r.current_balance, "000307500");
  assert.equal(r.k4_balloon_due_date, "02012055");
  assert.equal(r.k4_balloon_amount, "000014757");
  assert.equal(r.date_of_last_payment, "08102027");
  assert.equal(r.payment_history_profile, "222210000000000000000000");
  assert.equal(s.special_comment, "");
  assert.deepEqual(validateSnapshot(s), []);
});

test("8.1-T5 reinstatement: 08-31 → 11, balance 000292743, no K4", () => {
  const led = ledger("2027-01-01", [{ received_on: "2027-08-10", amount_cents: PITI * 7n }]);
  const s = buildSnapshot(state("2027-08-31", led, julySnapshot(), { upb_cents: cents("292743.16"), last_payment_on: d("2027-08-10") }));
  assert.equal(s.account_status, "11");
  assert.equal(renderBase(s).current_balance, "000292743");
  assert.equal(s.k4, null);
  assert.equal(s.dofd, null);
  assert.equal(s.php.slice(0, 5), "22221");
});

test("8.1-T6 modification: 11 + CO, new terms, balance incl. forborne, K4 balloon 000030000, Date Opened unchanged", () => {
  const led = ledger("2027-09-01");
  const s = buildSnapshot(state("2027-09-30", led, julySnapshot(), {
    upb_cents: cents("280000"), forborne_principal_cents: cents("30000"),
    condition: { kind: "modification", new_term_months: 480, new_piti_cents: cents("2100") },
  }));
  const r = renderBase(s);
  assert.equal(r.account_status, "11");
  assert.equal(s.special_comment, "CO");
  assert.equal(r.terms_duration, "480");
  assert.equal(r.current_balance, "000310000");
  assert.equal(r.k4_balloon_amount, "000030000");
  assert.equal(r.date_opened, "02142025");
});

test("8.1-T7/T8 terminal statuses: short sale 65+AU, foreclosure 94 w/ rating, DIL 89, payoff 13 rating 0; each final_reported", () => {
  const led = ledger("2027-01-01");
  const ss = buildSnapshot(state("2027-09-30", led, aprSnapshot(), { condition: { kind: "short_sale", closed_on: d("2027-09-15"), foreclosure_started: true } }));
  assert.equal(ss.account_status, "65"); assert.equal(ss.special_comment, "AU"); assert.equal(ss.payment_rating, "6");
  assert.equal(ss.current_balance_cents, 0n); assert.equal(ss.amount_past_due_cents, 0n); assert.equal(ss.date_closed, d("2027-09-15")); assert.ok(ss.final_reported);
  const fc = buildSnapshot(state("2027-09-30", led, aprSnapshot(), { condition: { kind: "foreclosure_sale", closed_on: d("2027-09-20"), deficiency_pursued: false } }));
  assert.equal(fc.account_status, "94"); assert.equal(fc.payment_rating, "6"); assert.equal(fc.current_balance_cents, 0n); assert.ok(fc.dofd);
  const dil = buildSnapshot(state("2027-09-30", led, aprSnapshot(), { condition: { kind: "deed_in_lieu", closed_on: d("2027-09-20") } }));
  assert.equal(dil.account_status, "89");
  const po = buildSnapshot(state("2027-09-30", ledger("2027-09-01"), julySnapshot(), { condition: { kind: "paid_in_full", closed_on: d("2027-09-10"), by_refinance: false } }));
  assert.equal(po.account_status, "13"); assert.equal(po.payment_rating, "0"); assert.equal(po.dofd, null); assert.ok(po.final_reported);
  for (const s of [ss, fc, dil, po]) assert.deepEqual(validateSnapshot(s), [], s.account_status);
});

test("8.1-T9 validation blocks 71 with blank DOFD; next month's PHP shows D for the omitted month", () => {
  const s = { ...aprSnapshot(), account_status: "71" as const, dofd: null };
  assert.ok(validateSnapshot(s).includes("DOFD_REQUIRED"));
  const next = carryPhp({ php: s.php, status: null, dofd: null, omitted: true });
  assert.equal(next[0], "D");
});

test("8.1-T10 anomaly hold: 3% unexplained status improvements holds the cycle", () => {
  const recs = Array.from({ length: 100 }, (_, i) => ({
    loan_id: `L${i}`, prior_status: "71" as const, status: i < 3 ? ("11" as const) : ("71" as const), explained_by_event: false, dofd_moved_later: false, deleted: false,
  }));
  const g = anomalyGate(recs);
  assert.ok(g.held);
  assert.match(g.reasons[0]!, /improvements 3\.00%/);
  assert.equal(anomalyGate(recs.map((r) => ({ ...r, explained_by_event: true }))).held, false);
});

test("8.1-T11 transmission deadlines: as_of 2027-01-31 with a servicer holiday Feb 2 → BD3 2027-02-04; hard stop 2027-02-10", () => {
  const c = transmissionClocks(d("2027-01-31"), servicerCalendar({ closures: [d("2027-02-02")] }));
  assert.equal(c.target, d("2027-02-04"));
  assert.equal(c.hard_stop, d("2027-02-10"));
});

test("8.1-T13 negative-information notice: 71 furnished 2027-03-03 without B-1 → B-2 by 2027-04-02; with B-1 none", () => {
  assert.equal(negativeInfoNoticeDue(d("2027-03-03"), false), d("2027-04-02"));
  assert.equal(negativeInfoNoticeDue(d("2027-03-03"), true), null);
});

test("8.1-T14 DOFD never later without evidence → DOFD_REAGE_BLOCKED; earlier or evidenced moves allowed", () => {
  assert.throws(() => correctDofd(d("2027-02-01"), d("2027-03-01"), null), DofdReageBlocked);
  assert.equal(correctDofd(d("2027-02-01"), d("2027-03-01"), "lockbox deposit 2027-02-05 misposted"), d("2027-03-01"));
  assert.equal(correctDofd(d("2027-03-01"), d("2027-02-01"), null), d("2027-02-01"));
});

test("8.1-T15 boarding history: hand-off PHP carried; no hand-off → B×24; reporter of the boarding month by the 15th rule", () => {
  const h = handoffHistory("000010000000000000000000", null, "11");
  const s = buildSnapshot(state("2027-01-31", ledger("2027-01-01"), h));
  assert.equal(s.php, "0" + "000010000000000000000000".slice(0, 23));
  assert.equal(carryPhp(null), "B".repeat(24));
  assert.equal(boardingMonthReporter(d("2027-02-10")), "supermortgage");
  assert.equal(boardingMonthReporter(d("2027-02-20")), "transferor");
});

test("8.1-T16 confirmed successor in interest is not furnished; J1/J2 by address; released co-borrower gets T + H", () => {
  const s = buildSnapshot(state("2027-01-31", ledger("2027-01-01"), JAN_PRIOR, {
    consumers: [
      { party_id: "A", position: 1, same_address_as_base: true, liability: "joint" },
      { party_id: "B", position: 2, same_address_as_base: false, liability: "joint" },
      { party_id: "S", position: 3, same_address_as_base: true, liability: "joint", successor_in_interest: true },
      { party_id: "R", position: 4, same_address_as_base: true, liability: "joint", released: true },
    ],
  }));
  assert.deepEqual(s.consumers.map((c) => [c.party_id, c.segment, c.ecoa, c.special_comment]), [["A", "base", "2", ""], ["B", "J2", "2", ""], ["R", "J1", "T", "H"]]);
});

test("8.1-T19 rounding: 4,919.10 → 000004919 truncate; round policy → 000004919 and 4,919.55 → 000004920", () => {
  assert.equal(metro2Money(cents("4919.10")), "000004919");
  assert.equal(metro2Money(cents("4919.10"), "round"), "000004919");
  assert.equal(metro2Money(cents("4919.55"), "round"), "000004920");
  assert.equal(metro2Money(cents("4919.55"), "truncate"), "000004919");
});

test("8.1 rule 1 buckets and PHP positions", () => {
  assert.deepEqual([0, 29, 30, 59, 60, 89, 90, 119, 120, 149, 150, 179, 180].map(statusForDays), ["11", "11", "71", "71", "78", "78", "80", "80", "82", "82", "83", "83", "84"]);
  assert.equal(phpPosition(d("2026-09-30"), d("2026-08-01")), 1);
  assert.equal(phpPosition(d("2026-09-30"), d("2026-03-01")), 6);
  assert.equal(phpPosition(d("2026-09-30"), d("2024-08-01")), null);
});

// ---- 8.2 disputes -----------------------------------------------------------

test("8.2-T5 direct dispute clocks: 2027-09-03 → 10-03; supplementation 09-20 → 10-18; supplementation 10-05 opens a new case", () => {
  const c = directDisputeClocks(d("2027-09-03"));
  assert.equal(c.results_due, d("2027-10-03"));
  assert.equal(c.dispatch_target, d("2027-09-28"));
  assert.equal(directDisputeClocks(d("2027-09-03"), d("2027-09-20")).extended_to, d("2027-10-18"));
  assert.equal(supplementationOpensNewCase(d("2027-09-03"), d("2027-10-05")), true);
  assert.equal(supplementationOpensNewCase(d("2027-09-03"), d("2027-09-20")), false);
});

test("8.2-T6 frivolous notice: determined Tue 2027-09-07 → due 2027-09-14 (5 federal BD); repeat with new information is investigated", () => {
  assert.equal(frivolousNoticeDue(d("2027-09-07")), d("2027-09-14"));
  assert.ok(frivolousEligible({ repeat: true, new_information: false, human_approved: true, channel: "direct_mail" }));
  assert.equal(frivolousEligible({ repeat: true, new_information: true, human_approved: true, channel: "direct_mail" }), false);
  assert.equal(frivolousEligible({ repeat: true, new_information: false, human_approved: true, channel: "acdv" }), false);
  assert.equal(frivolousEligible({ repeat: true, new_information: false, human_approved: false, channel: "direct_mail" }), false);
});

test("8.2-T1/T3 ACDV clocks: received 09-15, due 10-01 → internal target 09-22; outer bound 10-12; escalation at 90%", () => {
  const c = acdvClocks(d("2027-09-15"), d("2027-10-01"), d("2027-09-12"));
  assert.equal(c.internal_target, d("2027-09-22"));
  assert.equal(c.outer_bound, d("2027-10-12"));
  assert.equal(c.escalate_on, d("2027-09-29"));       // 16-day window × 0.9 = 14 days
});

test("8.2-T4 view-before-submit guard", () => {
  const g = new AcdvSubmitGuard();
  assert.equal(g.canSubmit("2027091500123"), false);
  g.view("2027091500123");
  assert.equal(g.canSubmit("2027091500123"), true);
});

test("8.2-T7 CCC lifecycle: XB on receipt (AUD if >10 days to cycle); XR on correction; XC with stated disagreement; XH otherwise", () => {
  assert.deepEqual(cccOnReceipt(d("2027-09-15"), d("2027-10-04")), { ccc: "XB", via: "aud" });
  assert.deepEqual(cccOnReceipt(d("2027-09-28"), d("2027-10-04")), { ccc: "XB", via: "next_cycle" });
  assert.equal(cccOnClose("modified"), "XR");
  assert.equal(cccOnClose("verified_as_reported", true), "XC");
  assert.equal(cccOnClose("verified_as_reported"), "XH");
  assert.equal(cccOnClose("unverifiable"), "XR");
});

test("8.2-T2 modify fan-out: AUDs to the other three bureaus within 2 BD; in-cycle still carries the value", () => {
  const f = correctionFanOut(d("2027-09-22"), "experian", false, true);
  assert.deepEqual(f.aud_to, ["equifax", "transunion", "innovis"]);
  assert.equal(f.aud_due, d("2027-09-24"));
  assert.ok(f.in_cycle);
  assert.equal(f.b2_notice_due, null);
  assert.equal(correctionFanOut(d("2027-09-22"), null, true, false).b2_notice_due, d("2027-10-22"));
});

test("8.2-T8 unverifiable pre-boarding item; 8.2-T12 reviewer conditions; 8.2-T9 deletes need officer", () => {
  assert.equal(preBoardingDetermination(false, false, false), "unverifiable");
  assert.equal(preBoardingDetermination(true, false, true), "verified_as_reported");
  assert.equal(requiresHumanReview({ determination: "verified_as_reported", confidence: 0.7 }).approver, "human_agent");
  assert.equal(requiresHumanReview({ determination: "verified_as_reported", confidence: 0.9 }).required, false);
  assert.equal(requiresHumanReview({ determination: "deleted_consumer", confidence: 0.99 }).approver, "officer");
});

// ---- 8.3 suppression --------------------------------------------------------

test("8.3-T1 NoE bar: March-2026 position renders D with XB inside the bar; 1 restored with XH after no-error closure", () => {
  // Loan otherwise current except a March-2026 installment paid 40 days late (a `1` in history).
  const inst = schedule("2025-03-01", 24);
  const pays = inst.map((i) => ({ received_on: i.due_date === d("2026-03-01") ? d("2026-04-10") : i.due_date, amount_cents: PITI }));
  const led = applyFifo(inst, pays).installments;
  // Prior history as of Aug-31-2026: position for Mar-2026 = 5 → build a PHP with a 1 there.
  let prior: PriorHistory = { php: "00001" + "0".repeat(19), status: "11", dofd: null };
  const bar = { received_on: d("2026-09-04"), scope: [d("2026-03-01")] };
  const sep = buildSnapshot(state("2026-09-30", led, prior, { last_payment_on: d("2026-09-01") }));
  assert.equal(sep.php[5], "1");                                              // position 6 = March 2026
  const sepTx = applyNoeBar(sep, led, bar, d("2026-10-05"), prior);
  assert.equal(sepTx.account_status, "11");
  assert.equal(sepTx.php[5], "D");
  assert.equal(sepTx.consumers[0]!.ccc, "XB");
  const oct = buildSnapshot(state("2026-10-31", led, sep, { last_payment_on: d("2026-10-01") }));
  const octTx = applyNoeBar(oct, led, bar, d("2026-11-03"), sep);
  assert.equal(octTx.php[6], "D");
  assert.equal(noeBarEnd(bar.received_on), d("2026-11-03"));
  const nov = buildSnapshot(state("2026-11-30", led, oct, { last_payment_on: d("2026-11-01") }));
  const novTx = applyNoeBar(nov, led, { ...bar, closed_on: d("2026-10-20"), outcome: "no_error" }, d("2026-12-03"), oct);
  assert.equal(novTx.php[7], "1");
  assert.equal(novTx.consumers[0]!.ccc, "XH");
});

test("8.3-T2 bar is evaluated at transmission time; 8.3-T3 partial scope reports July's delinquency", () => {
  const led = ledger("2027-05-01");                                            // June and July unpaid
  const s = buildSnapshot(state("2027-07-31", led, aprSnapshot()));
  assert.equal(s.account_status, "78");                                        // 60 days from Jun-1
  const bar = { received_on: d("2027-07-10"), scope: [d("2027-06-01")] };
  const inBar = applyNoeBar(s, led, bar, d("2027-08-03"), aprSnapshot());
  assert.equal(inBar.account_status, "71");                                    // June as-if-paid; July: 30 days → 71
  assert.equal(inBar.amount_past_due_cents, PITI);
  assert.equal(inBar.consumers[0]!.ccc, "XB");
  const after = applyNoeBar(s, led, { received_on: d("2026-09-04"), scope: [d("2026-03-01")] }, d("2026-11-04"), null);
  assert.equal(after.php, s.php);                                              // built 11-01, transmitted 11-04: projection not applied
});

test("8.3-T4 Chapter 13: Mar-31 71/CII D frozen APD 4919; Jun-30 11/CII D APD 0; Jan-31-2028 80/CII L DOFD 11012027; Feb-29-2028 CII Q", () => {
  const led = ledger("2027-01-01");
  const feb = buildSnapshot(state("2027-02-28", led, JAN_PRIOR));
  const mar = bankruptcyOverlay(buildSnapshot(state("2027-03-31", led, feb)), {
    party_id: "A", chapter: 13, petition_on: d("2027-03-10"), phase: { phase: "petition", petition_status: "71", petition_amount_past_due_cents: cents("4919.10") },
  }, led, feb);
  assert.equal(mar.account_status, "71");
  assert.equal(mar.consumers[0]!.cii, "D");
  assert.equal(renderBase(mar).amount_past_due, "000004919");
  assert.equal(renderBase(mar).date_of_first_delinquency, "02012027");
  assert.equal(renderBase(mar).current_balance, "000293063");
  // Post-petition Apr–Jun paid on time; pre-petition Feb/Mar cured through the trustee.
  const inst = schedule("2025-03-01", 40);
  const led2 = applyFifo(inst, inst.filter((i) => i.due_date <= d("2027-01-01") || (i.due_date >= d("2027-04-01") && i.due_date <= d("2027-06-01")))
    .map((i) => ({ received_on: i.due_date, amount_cents: PITI }))).installments;
  // FIFO would apply Apr–Jun cash to Feb–Apr; the overlay evaluates post-petition installments only, so supply them explicitly satisfied.
  const led2post = led2.map((i) => (i.due_date >= d("2027-04-01") && i.due_date <= d("2027-06-01")) ? { ...i, satisfied_on: i.due_date, paid_cents: PITI } : i);
  const jun = bankruptcyOverlay(buildSnapshot(state("2027-06-30", led2post, mar)), {
    party_id: "A", chapter: 13, petition_on: d("2027-03-10"), phase: { phase: "ch13_confirmed", plan_cures_arrears: true },
  }, led2post, mar);
  assert.equal(jun.account_status, "11");
  assert.equal(jun.consumers[0]!.cii, "D");
  assert.equal(jun.amount_past_due_cents, 0n);
  assert.equal(renderBase(jun).scheduled_monthly_payment, "000002459");
  assert.equal(jun.dofd, null);
  // Dismissed 2028-01-20 with Nov-1 and Dec-1 (and Jan-1) unpaid; pre-petition arrears cured.
  const led3 = applyFifo(inst, inst.filter((i) => i.due_date <= d("2027-10-01")).map((i) => ({ received_on: i.due_date, amount_cents: PITI }))).installments;
  const jan28 = bankruptcyOverlay(buildSnapshot(state("2028-01-31", led3, { ...jun, dofd: null })), {
    party_id: "A", chapter: 13, petition_on: d("2027-03-10"), phase: { phase: "dismissed", dismissed_on: d("2028-01-20"), cycles_since: 0 },
  }, led3, { php: jun.php, status: "11", dofd: null });
  assert.equal(jan28.account_status, "80");                                    // Nov-1 → Jan-31 = 91 days
  assert.equal(jan28.consumers[0]!.cii, "L");
  assert.equal(renderBase(jan28).date_of_first_delinquency, "11012027");
  assert.equal(renderBase(jan28).amount_past_due, "000007378");
  const feb28 = bankruptcyOverlay(buildSnapshot(state("2028-02-29", led3, jan28)), {
    party_id: "A", chapter: 13, petition_on: d("2027-03-10"), phase: { phase: "dismissed", dismissed_on: d("2028-01-20"), cycles_since: 1 },
  }, led3, jan28);
  assert.equal(feb28.consumers[0]!.cii, "Q");
});

test("8.3-T5 Chapter 7 discharge 2027-09-20 without reaffirmation: CII E, balances 0, Date Closed, final; reaffirmed → R", () => {
  const led = ledger("2027-09-01");
  const base = buildSnapshot(state("2027-09-30", led, julySnapshot()));
  const s = bankruptcyOverlay(base, { party_id: "A", chapter: 7, petition_on: d("2027-06-01"), phase: { phase: "ch7_discharged", reaffirmed: false, discharged_on: d("2027-09-20") } }, led, julySnapshot());
  assert.equal(s.consumers[0]!.cii, "E");
  assert.equal(s.current_balance_cents, 0n); assert.equal(s.amount_past_due_cents, 0n); assert.equal(s.scheduled_monthly_payment_cents, 0n);
  assert.equal(renderBase(s).date_closed, "09202027");
  assert.ok(s.final_reported);
  const r = bankruptcyOverlay(base, { party_id: "A", chapter: 7, petition_on: d("2027-06-01"), phase: { phase: "ch7_discharged", reaffirmed: true, discharged_on: d("2027-09-20") } }, led, null);
  assert.equal(r.consumers[0]!.cii, "R"); assert.equal(r.final_reported, false);
});

test("8.3-T6 SCRA: reduced P&I 1,800.91, forgiven May interest 60.85, PITI 2,413.31; missed reduced payment held for officer", () => {
  const p = scraReducedPayment(cents("292096.58"), RATE, 334, ESCROW);
  assert.equal(p.pi_cents, cents("1800.91"));
  assert.equal(p.forgiven_interest_cents, cents("60.85"));
  assert.equal(p.piti_cents, cents("2413.31"));
  const led = ledger("2027-05-01");
  const may = buildSnapshot(state("2027-05-31", led, aprSnapshot(), { payments_in_month_cents: p.piti_cents }));
  const scra = { party_id: "A", relief_from: d("2027-05-01"), relief_to: null, reduced_piti_cents: p.piti_cents, stay_granted: false };
  const r = scraOverlay({ ...may, account_status: "11", dofd: null }, scra, { php: may.php, status: "11", dofd: null });
  assert.equal(renderBase(r.snapshot).scheduled_monthly_payment, "000002413");
  assert.equal(renderBase(r.snapshot).actual_payment_amount, "000002413");
  assert.notEqual(r.snapshot.special_comment, "AI");
  assert.equal(r.held_for_officer, false);
  const aug = { ...may, as_of: d("2027-08-31"), account_status: "71" as const };
  assert.equal(scraOverlay(aug, scra, { php: may.php, status: "11", dofd: null }).held_for_officer, true);
  assert.equal(scraOverlay(aug, { ...scra, officer_reviewed_adverse: true }, { php: may.php, status: "11", dofd: null }).held_for_officer, false);
});

test("8.3-T7 disaster: AW on the Aug-31 record; CP replaces AW under a disaster forbearance", () => {
  const led = ledger("2027-08-01");
  const aug = disasterOverlay(buildSnapshot(state("2027-08-31", led, julySnapshot(), { disaster_case_open: true })), d("2027-08-20"));
  assert.equal(aug.special_comment, "AW");
  const sep = disasterOverlay(buildSnapshot(state("2027-09-30", led, aug, {
    disaster_case_open: true, condition: { kind: "forbearance", effective_on: d("2027-09-01"), entry_status: "11", entry_amount_past_due_cents: 0n, plan_payment_cents: 0n },
  })), d("2027-08-20"));
  assert.equal(sep.special_comment, "CP");
});

test("8.3-T8 deceased co-borrower B → ECOA X on B's segment only; successor never added", () => {
  const s = deceasedOverlay(buildSnapshot(state("2027-04-30", ledger("2027-04-01"), JAN_PRIOR, {
    consumers: [
      { party_id: "A", position: 1, same_address_as_base: true, liability: "joint" },
      { party_id: "B", position: 2, same_address_as_base: true, liability: "joint" },
      { party_id: "D", position: 3, same_address_as_base: true, liability: "joint", successor_in_interest: true },
    ],
  })), "B");
  assert.deepEqual(s.consumers.map((c) => [c.party_id, c.ecoa]), [["A", "2"], ["B", "X"]]);
});

test("8.3-T9 identity theft block 2027-05-03: omit C, AUD by 05-05, fraud case, resumption requires officer + BRR", () => {
  const r = identityTheftResponse({ party_id: "C", received_on: d("2027-05-03"), never_liable: false }, d("2027-05-05"));
  assert.equal(r.suppression.mechanism, "omit_account");
  assert.equal(r.aud_due, d("2027-05-05"));
  assert.ok(r.resumption_requires.includes("officer_approval") && r.resumption_requires.includes("brr_with_evidence"));
  assert.equal(identityTheftResponse({ party_id: "C", received_on: d("2027-05-03"), never_liable: true }, d("2027-05-05")).suppression.mechanism, "delete_consumer");
});

test("8.3-T10 FDCPA gate: notice 02-12 with no undeliverability → included in Feb-28 cycle; undeliverable 02-20 → omitted until live contact", () => {
  assert.equal(fdcpaGateOpensOn({ live_contact_on: null, validation_notice_sent_on: d("2027-02-12"), undeliverable_on: null }), d("2027-02-26"));
  assert.ok(fdcpaGateIncludes({ live_contact_on: null, validation_notice_sent_on: d("2027-02-12"), undeliverable_on: null }, d("2027-02-28")));
  assert.equal(fdcpaGateIncludes({ live_contact_on: null, validation_notice_sent_on: d("2027-02-12"), undeliverable_on: d("2027-02-20") }, d("2027-02-28")), false);
  assert.ok(fdcpaGateIncludes({ live_contact_on: d("2027-03-02"), validation_notice_sent_on: d("2027-02-12"), undeliverable_on: d("2027-02-20") }, d("2027-03-31")));
});

test("8.3-T12/T13/T14: no courtesy suppression; sample verification thresholds; priority resolution", () => {
  assert.equal(courtesyRequest().created, false);
  const sv = sampleVerification(5000, 248, 250);
  assert.equal(sv.sample_size, 250);
  assert.ok(sv.escalate);                                                       // 99.2% < 99.5%
  assert.equal(sampleVerification(5000, 250, 250).escalate, false);
  const active: Suppression[] = [
    { reason: "bankruptcy", mechanism: "freeze_status", party_id: "A", starts_on: d("2027-03-10"), ends_on: null, codes: ["CII D"] },
    { reason: "dispute_open", mechanism: "flag_only", party_id: "A", starts_on: d("2027-09-15"), ends_on: null, codes: ["XB"] },
    { reason: "scra", mechanism: "freeze_status", party_id: "A", starts_on: d("2027-05-01"), ends_on: null },
  ];
  const r = resolveSuppression(active, d("2027-09-30"), "A")!;
  assert.equal(r.mechanism, "freeze_status");
  assert.deepEqual(r.codes, ["CII D", "XB"]);
  assert.equal(r.reasons.length, 3);
});

test("8.1 rule 13 arithmetic: P&I 1,847.15 from the note terms", () => {
  assert.equal(levelPayment(cents("300000"), RATE, 360), cents("1847.15"));
  assert.equal(deriveDelinquency(ledger("2027-01-01"), d("2027-04-30")).amount_past_due_cents, cents("7378.65"));
});
