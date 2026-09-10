// 8.1 Furnish tradeline (Metro 2)
// spec/sections/08-credit-reporting/8-1-furnish-tradeline-metro-2.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, addMonths } from "../../kernel/calendar/date.ts";
import { servicerCalendar, defaultCalendars, type CalendarSet } from "../../kernel/calendar/business.ts";
import { cents, levelPayment, ratePercent, sumCents } from "../../kernel/money/cents.ts";
import { MemoryEventStore, FixedClock, eventMatches, type Actor, type EventStore } from "../../kernel/events/index.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { scheduledUpbAfter } from "../notices/ops.ts";
import { applyFifo, type AppliedInstallment } from "../boarding/delinquency.ts";
import { nib } from "../lossmit/deferral.ts";
import { fdcpaStatusAtBoarding, recordValidationSent, fdcpaSweep, recordConversation } from "../early-intervention/fdcpa.ts";
import { NoticeService, NoticeHeld } from "../../notices/service.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { FakePrintMail, FakeEdelivery } from "../../infra/integrations/delivery.ts";
import { buildSnapshot, renderBase, metro2Money, validateSnapshot, anomalyGate, transmissionClocks, negativeInfoNoticeDue, correctDofd, DofdReageBlocked, handoffHistory, boardingMonthReporter, carryPhp, statusForDays } from "./metro2.ts";
import { buildCycle, phpAfterOmission, CreditCycleRunner, CreditReportingRefused, ackRejectLoop, fdcpaCycleInclusion, cycleFiles, type BureauConfig } from "./ops.ts";
import { recordPolicyReview, nextPolicyReviewDue, policyReviewStatus, POLICY_REVIEW_SUBJECT, fdcpaGateState, fdcpaCycleInput, b1EvidenceOnFile, b2Plan, mailB2Notices, B1_TEMPLATE, B2_TEMPLATE, finalReportedAfter, nextCycleCandidates } from "./ops-8-1.ts";
import type { CreditLoanState, PriorHistory, LoanCondition, Metro2Snapshot } from "./types.ts";
import type { Bureau } from "./disputes.ts";

// ---- fixtures: loan SM-1001 (rule 13), four bureaus, actors, the registry after every override ----------------------
const AGENT: Actor = { kind: "agent", id: "credit-reporting" };
const OFFICER: Actor = { kind: "human", id: "u-officer", role: "officer" };
const ANALYST: Actor = { kind: "human", id: "u-analyst", role: "ops_analyst" };
const BOARDING: Actor = { kind: "agent", id: "boarding" };
const EI: Actor = { kind: "agent", id: "early-intervention" };
const CONFIG: Record<Bureau, BureauConfig> = { equifax: { program_identifier: "EFX-PROG", subscriber_code: "EFX123", file_naming: "SM_{cycle}_{bureau}.m2" }, experian: { program_identifier: "EXP-PROG", subscriber_code: "EXP123", file_naming: "SM_{cycle}_{bureau}.m2" }, transunion: { program_identifier: "TU-PROG", subscriber_code: "TU123", file_naming: "SM_{cycle}_{bureau}.m2" }, innovis: { program_identifier: "INV-PROG", subscriber_code: "INV123", file_naming: "SM_{cycle}_{bureau}.m2" } };
const SHA256 = /^[0-9a-f]{64}$/;
const REG = loadOverriddenRegistry();
const engineFor = (events: EventStore, calendars?: CalendarSet) => new TimerEngine(REG, events, { processes: ["8.1"], ...(calendars ? { calendars } : {}) });
const armed = (engine: TimerEngine, code: string) => engine.byCode(code).filter((t) => t.status === "armed");
const satisfied = (engine: TimerEngine, code: string) => engine.byCode(code).filter((t) => t.status === "satisfied" || t.status === "satisfied_late");

const PI = cents("1847.15"), ESCROW = cents("612.40"), PITI = PI + ESCROW;
const RATE = ratePercent("6.25");
function schedule(from: string, n: number) { return Array.from({ length: n }, (_, i) => ({ due_date: addMonths(D(from), i), amount_cents: PITI })); }
/** Installments 2025-03-01 … with payments through `paidThrough` (inclusive), plus extra receipts. */
function ledger(paidThrough: string, extra: { received_on: string; amount_cents: bigint }[] = []): readonly AppliedInstallment[] {
  const inst = schedule("2025-03-01", 40);
  const pays = inst.filter((i) => i.due_date <= D(paidThrough)).map((i) => ({ received_on: i.due_date, amount_cents: PITI }));
  return applyFifo(inst, [...pays, ...extra.map((e) => ({ received_on: D(e.received_on), amount_cents: e.amount_cents }))]).installments;
}
function state(asOf: string, installments: readonly AppliedInstallment[], prior: PriorHistory | Metro2Snapshot | null, over: Partial<CreditLoanState> = {}): CreditLoanState {
  return {
    loan_id: "SM-1001", as_of: D(asOf), installments, upb_cents: cents("293063.94"), deferred_principal_cents: 0n, forborne_principal_cents: 0n,
    pi_cents: PI, escrow_cents: ESCROW, original_amount_cents: cents("300000"), note_date: D("2025-02-14"), maturity_date: D("2055-02-01"),
    original_term_months: 360, remaining_term_months: 337, interest_type: "F", fnma_loan_number: "1234567890", min: "100012345678901234",
    payments_in_month_cents: PITI, last_payment_on: D("2027-01-01"), condition: { kind: "none" },
    consumers: [{ party_id: "A", position: 1, same_address_as_base: true, liability: "individual" }], prior, ...over,
  };
}
const JAN_PRIOR: PriorHistory = { php: "0000000000000000000000BB".slice(1) + "B", status: "11", dofd: null }; // Dec-2026 snapshot
const FORBEARANCE: LoanCondition = { kind: "forbearance", effective_on: D("2027-05-01"), entry_status: "78", entry_amount_past_due_cents: cents("7378.65"), plan_payment_cents: 0n };
function aprSnapshot(): Metro2Snapshot {
  const led = ledger("2027-01-01");
  const jan = buildSnapshot(state("2027-01-31", led, JAN_PRIOR));
  const feb = buildSnapshot(state("2027-02-28", led, jan, { payments_in_month_cents: 0n }));
  const mar = buildSnapshot(state("2027-03-31", led, feb, { payments_in_month_cents: 0n }));
  return buildSnapshot(state("2027-04-30", led, mar, { payments_in_month_cents: 0n }));
}
function julySnapshot(): Metro2Snapshot {
  const led = ledger("2027-01-01");
  let prior: Metro2Snapshot = aprSnapshot();
  for (const m of ["2027-05-31", "2027-06-30", "2027-07-31"]) prior = buildSnapshot(state(m, led, prior, { condition: FORBEARANCE, payments_in_month_cents: 0n }));
  return prior;
}
const snap = (loan: string): Metro2Snapshot => ({ loan_id: loan, as_of: D("2027-01-31"), account_status: "11", payment_rating: null, special_comment: "", current_balance_cents: 29306394n, amount_past_due_cents: 0n, scheduled_monthly_payment_cents: 245955n, actual_payment_cents: 245955n, original_loan_amount_cents: 30000000n, original_charge_off_cents: 0n, days_past_due: 0, dofd: null, date_opened: D("2025-02-14"), date_closed: null, date_of_last_payment: D("2027-01-01"), terms_duration: 360, interest_type: "F", php: "0000000000000000000000BB", k3: { agency_identifier: "01", fnma_loan_number: "1234567890", min: "100012345678901234" }, k4: null, consumers: [{ party_id: "A", segment: "base", ecoa: "1", cii: "", ccc: "", special_comment: "" }], final_reported: false, derivation: [] });

test("8.1-T1: (happy path) Given loan SM-1001 current on 2027-01-31, when the cycle builds, then the Base record shows status 11, Current Balance 000293063, PHP `0000000000000000000000BB`, K3 with MIN, and four files are transmitted by the 3rd servicer business day with hashes recorded.", () => {
  // The Jan snapshot is built from the Dec-2026 snapshot whose PHP already holds 21 zeros + BBB (rule 4: carried, never recomputed).
  const dec: PriorHistory = { php: "0".repeat(21) + "BBB", status: "11", dofd: null };
  const s = buildSnapshot(state("2027-01-31", ledger("2027-01-01"), dec));
  const r = renderBase(s);
  assert.equal(r.account_status, "11");
  assert.equal(r.current_balance, "000293063");                                   // UPB $293,063.94 after payment #23, truncated (rule 2)
  assert.equal(r.amount_past_due, "000000000"); assert.equal(r.date_of_first_delinquency, "00000000");
  assert.equal(r.scheduled_monthly_payment, "000002459"); assert.equal(r.actual_payment_amount, "000002459");
  assert.equal(r.payment_history_profile, "0000000000000000000000BB");
  assert.deepEqual(s.k3, { agency_identifier: "01", fnma_loan_number: "1234567890", min: "100012345678901234" });
  assert.deepEqual(validateSnapshot(s), []);
  // …and four files are transmitted by the 3rd servicer business day with hashes recorded (rules 10/11; SM_METRO2_TRANSMIT_ALL4_BD3 armed by `credit.cycle.opened`, satisfied by the all-bureaus `metro2.file.transmitted`).
  const clock = new FixedClock("2027-02-01T05:05:00.000Z");
  const events = new MemoryEventStore(clock);
  const engine = engineFor(events);
  const runner = new CreditCycleRunner(events, AGENT);
  runner.open("2027-01", D("2027-01-31"));
  assert.equal(armed(engine, "SM_METRO2_TRANSMIT_ALL4_BD3")[0]!.dueDate, D("2027-02-03"), "Sun 01-31 → Mon 02-01, Tue 02-02, Wed 02-03 (servicer calendar)");
  assert.equal(armed(engine, "SM_METRO2_TRANSMIT_HARD_CD10")[0]!.dueDate, D("2027-02-10"));
  const b = runner.build({ cycle_id: "2027-01", as_of: D("2027-01-31"), records: [{ snapshot: s, prior_status: "11", b1_on_file: true }], config: CONFIG });
  assert.equal(b.status, "validated"); assert.equal(b.record_count, 1); assert.deepEqual(b.omitted, []);
  assert.equal(b.transmit_by.target, D("2027-02-03")); assert.equal(b.transmit_by.hard_stop, D("2027-02-10"));
  assert.equal(b.files.length, 4); for (const f of b.files) assert.match(f.hash, SHA256);
  assert.equal(new Set(b.files.map((f) => f.hash)).size, 4, "the idempotency key (cycle_id, bureau, hash) — one per bureau file");
  assert.ok(b.files.every((f) => f.records[0]!.date_of_first_delinquency === "00000000" && f.records[0]!.account_status === "11"));
  clock.set("2027-02-03T14:00:00.000Z");
  const t = runner.transmit(b, "2027-02-03T14:00:00.000Z");
  assert.equal(t.on_time, true); assert.equal(t.transmitted_on, D("2027-02-03"));
  assert.deepEqual(t.transmitted.map((x) => x.bureau).sort(), ["equifax", "experian", "innovis", "transunion"]);
  const tx = events.ofType("metro2.file.transmitted");
  assert.equal(tx.length, 5, "one per bureau plus the all-bureaus cycle event");
  assert.ok(tx.filter((e) => e.payload.all_bureaus === false).every((e) => SHA256.test(String(e.payload.hash))), "hashes recorded on every per-bureau transmission");
  assert.deepEqual(Object.keys(events.ofType("credit.cycle.validated")[0]!.payload.hashes as Record<string, string>).sort(), ["equifax", "experian", "innovis", "transunion"]);
  assert.equal(satisfied(engine, "SM_METRO2_TRANSMIT_ALL4_BD3").length, 1); assert.equal(satisfied(engine, "SM_METRO2_TRANSMIT_HARD_CD10").length, 1);
  assert.equal(armed(engine, "SM_METRO2_ACK_EXPECTED_BD").length, 4, "one acknowledgment clock per bureau file");
  assert.equal(events.ofType("metro2.loan.furnished")[0]!.payload.negative_information, false);
});

test("8.1-T2: (delinquency buckets) Given Feb-1 missed, then 02-28 → 11 (27 days), 03-31 → 71 with DOFD 02012027, 04-30 → 78; Amount Past Due 000002459 / 000004919 / 000007378.", () => {
  const led = ledger("2027-01-01");
  const jan = buildSnapshot(state("2027-01-31", led, JAN_PRIOR));
  const feb = buildSnapshot(state("2027-02-28", led, jan, { payments_in_month_cents: 0n }));
  assert.equal(feb.days_past_due, 27); assert.equal(renderBase(feb).account_status, "11");
  assert.equal(renderBase(feb).amount_past_due, "000002459");                    // $2,459.55 truncated (rule 2)
  assert.equal(renderBase(feb).date_of_first_delinquency, "00000000", "DOFD populated only with a 71+ status (rule 3, policy †)");
  assert.equal(feb.php[0], "0", "PHP position 1 = January, reported 11");
  const mar = buildSnapshot(state("2027-03-31", led, feb, { payments_in_month_cents: 0n }));
  assert.equal(mar.days_past_due, 58); assert.equal(mar.account_status, "71");
  assert.equal(renderBase(mar).date_of_first_delinquency, "02012027"); assert.equal(mar.dofd, D("2027-02-01"));
  assert.equal(renderBase(mar).amount_past_due, "000004919");                    // $4,919.10
  assert.equal(mar.php[0], "0", "Feb-28 status was 11");
  const apr = buildSnapshot(state("2027-04-30", led, mar, { payments_in_month_cents: 0n }));
  assert.equal(apr.days_past_due, 88); assert.equal(apr.account_status, "78");
  assert.equal(renderBase(apr).amount_past_due, "000007378");                    // $7,378.65
  assert.equal(apr.php.slice(0, 3), "100"); assert.equal(apr.dofd, D("2027-02-01"), "DOFD never moves later while the same delinquency continues");
  assert.deepEqual([feb, mar, apr].map((s) => validateSnapshot(s)), [[], [], []]);
  assert.deepEqual([0, 29, 30, 59, 60, 89, 90, 119, 120, 149, 150, 179, 180].map(statusForDays), ["11", "11", "71", "71", "78", "78", "80", "80", "82", "82", "83", "83", "84"]);
});

test("8.1-T3: (forbearance freeze) Given forbearance effective 05-01, then 05-31…07-31 report 78 + CP with Amount Past Due frozen; with `policy.forbearance_status='contractual_aging'` the same months report 80/82/84.", () => {
  const led = ledger("2027-01-01");
  let prior: Metro2Snapshot = aprSnapshot();
  assert.equal(prior.account_status, "78", "status at plan entry");
  const frozen: Metro2Snapshot[] = [];
  for (const m of ["2027-05-31", "2027-06-30", "2027-07-31"]) { prior = buildSnapshot(state(m, led, prior, { condition: FORBEARANCE, payments_in_month_cents: 0n })); frozen.push(prior); }
  for (const s of frozen) {
    assert.equal(s.account_status, "78"); assert.equal(s.special_comment, "CP");
    assert.equal(renderBase(s).amount_past_due, "000007378", "Amount Past Due frozen at entry");
    assert.equal(renderBase(s).scheduled_monthly_payment, "000000000", "payments suspended → plan amount 0 †");
    assert.equal(renderBase(s).date_of_first_delinquency, "02012027", "DOFD retained");
    assert.deepEqual(validateSnapshot(s), []);
  }
  assert.equal(frozen[2]!.php.slice(0, 6), "222100", "PHP at 07-31 accumulates 2 for Apr, then 2,2 for May/Jun under the freeze");
  // 8.1-Q4 alternative: contractual aging with CP
  const aging = { metro2_rounding: "truncate", forbearance_status: "contractual_aging", terms_duration: "original" } as const;
  let p2: Metro2Snapshot = aprSnapshot();
  const statuses: string[] = []; const days: number[] = [];
  for (const m of ["2027-05-31", "2027-06-30", "2027-07-31"]) { p2 = buildSnapshot(state(m, led, p2, { condition: FORBEARANCE, payments_in_month_cents: 0n }), aging); statuses.push(p2.account_status); days.push(p2.days_past_due); assert.equal(p2.special_comment, "CP"); }
  assert.deepEqual(days, [119, 149, 180]);
  assert.deepEqual(statuses, ["80", "82", "84"]);
  assert.equal(p2.php.slice(0, 5), "43210");
});

test("8.1-T4: (deferral cure) Given deferral completed 08-15 with $14,757.30 deferred, then 08-31 reports 11, Current Balance 000307500, K4 01/02012055/000014757, DOFD zero-filled, PHP `222210…`.", () => {
  // Deferral (12.6): 6 × P&I $1,847.15 = $11,082.90 plus escrow advances 6 × $612.40 = $3,674.40 → non-interest-bearing $14,757.30.
  const escrowAdvances = sumCents(Array.from({ length: 6 }, () => ESCROW));
  const deferred = nib(PI, 6, escrowAdvances, 0n);
  assert.equal(deferred, cents("14757.30"));
  // Ledger: Feb–Jul satisfied by the deferral on 08-15 (not cash), the August installment paid 08-10.
  const inst = schedule("2025-03-01", 40);
  const led = applyFifo(inst, [
    ...inst.filter((i) => i.due_date <= D("2027-01-01")).map((i) => ({ received_on: i.due_date, amount_cents: PITI })),
    { received_on: D("2027-08-10"), amount_cents: PITI },
    { received_on: D("2027-08-15"), amount_cents: PITI * 6n },
  ]).installments;
  const s = buildSnapshot(state("2027-08-31", led, julySnapshot(), { upb_cents: cents("292743.16"), deferred_principal_cents: deferred, condition: { kind: "deferral" }, last_payment_on: D("2027-08-10") }));
  const r = renderBase(s);
  assert.equal(r.account_status, "11"); assert.equal(r.amount_past_due, "000000000");
  assert.equal(r.date_of_first_delinquency, "00000000", "DOFD zero-filled: the deferral cures the delinquency going forward");
  assert.equal(s.current_balance_cents, cents("292743.16") + deferred);        // $307,500.46
  assert.equal(r.current_balance, "000307500");
  assert.equal(s.k4!.specialized_payment_indicator, "01"); assert.equal(r.k4_balloon_due_date, "02012055"); assert.equal(r.k4_balloon_amount, "000014757");
  assert.equal(r.date_of_last_payment, "08102027"); assert.equal(r.scheduled_monthly_payment, "000002459");
  assert.equal(s.special_comment, "", "CP dropped; a deferral is not a modification (8.1-Q7)");
  assert.equal(r.payment_history_profile, "222210000000000000000000", "history preserved — the deferral does not erase it");
  assert.deepEqual(validateSnapshot(s), []);
});

test("8.1-T5: (reinstatement) Given reinstatement on 08-10, then 08-31 reports 11, Current Balance 000292743, no K4.", () => {
  // Reinstatement: $14,757.30 of arrears (Feb–Jul) plus the August installment received 08-10 → seven installments satisfied by cash.
  const led = ledger("2027-01-01", [{ received_on: "2027-08-10", amount_cents: PITI * 7n }]);
  assert.equal(led.filter((i) => i.satisfied_on === D("2027-08-10")).length, 7);
  const s = buildSnapshot(state("2027-08-31", led, julySnapshot(), { upb_cents: cents("292743.16"), last_payment_on: D("2027-08-10") }));
  const r = renderBase(s);
  assert.equal(r.account_status, "11"); assert.equal(s.days_past_due, 0);
  assert.equal(r.current_balance, "000292743");
  assert.equal(s.k4, null); assert.equal(r.k4_balloon_amount, "");
  assert.equal(s.dofd, null); assert.equal(r.date_of_first_delinquency, "00000000");
  assert.equal(r.payment_history_profile, "222210000000000000000000", "same PHP as the deferral path");
  assert.deepEqual(validateSnapshot(s), []);
});

test("8.1-T6: (modification) Given a Flex Mod effective 2027-09-01 with capitalized arrears and $30,000 forborne principal, then status 11, CO, new Terms Duration, Current Balance incl. forborne, K4 01 balloon = 000030000, Date Opened unchanged, no new tradeline.", () => {
  const led = ledger("2027-09-01");
  const s = buildSnapshot(state("2027-09-30", led, julySnapshot(), { upb_cents: cents("280000"), forborne_principal_cents: cents("30000"), condition: { kind: "modification", new_term_months: 480, new_piti_cents: cents("2100") } }));
  const r = renderBase(s);
  assert.equal(r.account_status, "11", "brought current by the modification");
  assert.equal(s.special_comment, "CO", "loan modified — Flex Mod is not a federal government plan (8.1-Q6)");
  assert.equal(r.terms_duration, "480"); assert.equal(r.scheduled_monthly_payment, "000002100");
  assert.equal(r.current_balance, "000310000", "new UPB incl. capitalization + forborne principal");
  assert.equal(s.k4!.specialized_payment_indicator, "01"); assert.equal(r.k4_balloon_amount, "000030000"); assert.equal(r.k4_balloon_due_date, "02012055");
  assert.equal(r.date_opened, "02142025", "Date Opened unchanged");
  assert.equal(r.date_of_first_delinquency, "00000000"); assert.equal(r.amount_past_due, "000000000");
  assert.deepEqual(validateSnapshot(s), []);
  // no new tradeline: the cycle carries one record for SM-1001 under the same account, not a second one
  const b = buildCycle({ cycle_id: "2027-09", as_of: D("2027-09-30"), records: [{ snapshot: s, prior_status: "78", explained_by_event: true }], config: CONFIG });
  assert.equal(b.record_count, 1); assert.deepEqual(b.included.map((x) => x.loan_id), ["SM-1001"]);
  assert.ok(b.files.every((f) => f.records.length === 1 && f.records[0]!.date_opened === "02142025"));
});

test("8.1-T7: (short sale) Given a short sale closed with foreclosure previously referred, then 65 + AU, Payment Rating from the delinquency at closing, balances 0, Date Closed = closing date.", () => {
  // Paid through 05-01; Jun-1 unpaid. Closing 07-20 = 49 days past due (bucket 71 → rating 1); the 07-31 snapshot date would be 60 days (78).
  const led = ledger("2027-05-01");
  const referred = buildSnapshot(state("2027-06-30", led, JAN_PRIOR, { foreclosure_referred: true, payments_in_month_cents: 0n }));
  assert.equal(referred.special_comment, "BO", "foreclosure proceedings started");
  const s = buildSnapshot(state("2027-07-31", led, referred, { foreclosure_referred: true, payments_in_month_cents: 0n, condition: { kind: "short_sale", closed_on: D("2027-07-20"), foreclosure_started: true } }));
  const r = renderBase(s);
  assert.equal(s.account_status, "65", "foreclosure had started"); assert.equal(s.special_comment, "AU", "paid in full for less than the full balance");
  assert.equal(s.days_past_due, 60); assert.equal(statusForDays(60), "78");
  assert.equal(s.payment_rating, "1", "Payment Rating = the delinquency bucket at the closing date (49 days), not at the snapshot date");
  assert.equal(s.current_balance_cents, 0n); assert.equal(s.amount_past_due_cents, 0n);
  assert.equal(r.current_balance, "000000000"); assert.equal(r.amount_past_due, "000000000");
  assert.equal(s.date_closed, D("2027-07-20")); assert.equal(r.date_closed, "07202027");
  assert.equal(r.date_of_first_delinquency, "06012027", "DOFD retained on the terminal status");
  assert.ok(s.final_reported); assert.deepEqual(validateSnapshot(s), []);
  // without a foreclosure referral the same closing reports 13 + AU
  const plain = buildSnapshot(state("2027-07-31", led, referred, { payments_in_month_cents: 0n, condition: { kind: "short_sale", closed_on: D("2027-07-20"), foreclosure_started: false } }));
  assert.equal(plain.account_status, "13"); assert.equal(plain.special_comment, "AU"); assert.equal(plain.payment_rating, "1");
});

test("8.1-T8: (foreclosure/DIL/payoff) Given sale completed → 94 with Payment Rating; DIL → 89; payoff → 13 with Payment Rating 0; each reported once, then `final_reported`.", () => {
  const led = ledger("2027-01-01");
  const fc = buildSnapshot(state("2027-09-30", led, aprSnapshot(), { loan_id: "SM-1001", payments_in_month_cents: 0n, condition: { kind: "foreclosure_sale", closed_on: D("2027-09-20"), deficiency_pursued: false } }));
  assert.equal(fc.account_status, "94"); assert.equal(fc.payment_rating, "6", "231 days past due at the sale"); assert.equal(fc.current_balance_cents, 0n); assert.equal(fc.dofd, D("2027-02-01")); assert.equal(fc.date_closed, D("2027-09-20"));
  const dil = buildSnapshot(state("2027-09-30", led, aprSnapshot(), { loan_id: "SM-1002", payments_in_month_cents: 0n, condition: { kind: "deed_in_lieu", closed_on: D("2027-09-20") } }));
  assert.equal(dil.account_status, "89"); assert.equal(dil.payment_rating, "6"); assert.equal(dil.current_balance_cents, 0n, "no deficiency by Fannie Mae policy"); assert.equal(dil.date_closed, D("2027-09-20"));
  const po = buildSnapshot(state("2027-09-30", ledger("2027-09-01"), julySnapshot(), { loan_id: "SM-1003", condition: { kind: "paid_in_full", closed_on: D("2027-09-10"), by_refinance: false } }));
  assert.equal(po.account_status, "13"); assert.equal(po.payment_rating, "0", "current at payoff"); assert.equal(po.dofd, null); assert.equal(po.current_balance_cents, 0n); assert.equal(po.date_closed, D("2027-09-10"));
  for (const s of [fc, dil, po]) { assert.ok(s.final_reported, s.account_status); assert.deepEqual(validateSnapshot(s), [], s.account_status); }
  // each reported once (one `metro2.loan.furnished` per loan in the final cycle), then `final_reported`: the next cycle skips them unless a correction requires it
  const events = new MemoryEventStore(new FixedClock("2027-10-01T05:05:00.000Z"));
  const runner = new CreditCycleRunner(events, AGENT);
  runner.open("2027-09", D("2027-09-30"));
  const b = runner.build({ cycle_id: "2027-09", as_of: D("2027-09-30"), records: [fc, dil, po].map((snapshot) => ({ snapshot, explained_by_event: true, b1_on_file: true })), config: CONFIG });
  assert.equal(b.status, "validated"); assert.equal(b.record_count, 3);
  runner.transmit(b, "2027-10-04T14:00:00.000Z");
  const furnished = events.ofType("metro2.loan.furnished");
  assert.deepEqual(furnished.map((e) => [e.loanId, e.payload.account_status]).sort(), [["SM-1001", "94"], ["SM-1002", "89"], ["SM-1003", "13"]]);
  const final = finalReportedAfter(b);
  assert.deepEqual([...final].sort(), ["SM-1001", "SM-1002", "SM-1003"]);
  const octCandidates = [{ ...fc, as_of: D("2027-10-31") }, { ...dil, as_of: D("2027-10-31") }, { ...po, as_of: D("2027-10-31") }, snap("SM-1004")];
  const next = nextCycleCandidates(octCandidates, final);
  assert.deepEqual(next.included.map((s) => s.loan_id), ["SM-1004"]);
  assert.deepEqual(next.skipped, [{ loan_id: "SM-1001", reason: "final_reported" }, { loan_id: "SM-1002", reason: "final_reported" }, { loan_id: "SM-1003", reason: "final_reported" }]);
  assert.deepEqual(nextCycleCandidates(octCandidates, final, new Set(["SM-1002"])).included.map((s) => s.loan_id), ["SM-1002", "SM-1004"], "reported again only when a correction requires it");
});

test("8.1-T9: (validation blocks) Given a record with status 71 and blank DOFD, then it is excluded from the file, an exception is created, and next month's PHP shows `D` for that month if unresolved.", () => {
  const bad: Metro2Snapshot = { ...aprSnapshot(), account_status: "71", dofd: null };
  assert.deepEqual(validateSnapshot(bad), ["DOFD_REQUIRED"]);
  const ok = { ...aprSnapshot(), loan_id: "SM-1002" };
  const events = new MemoryEventStore(new FixedClock("2027-05-01T05:05:00.000Z"));
  const runner = new CreditCycleRunner(events, AGENT);
  const b = runner.build({ cycle_id: "2027-04", as_of: D("2027-04-30"), records: [{ snapshot: bad }, { snapshot: ok }], config: CONFIG });
  assert.deepEqual(b.exceptions, [{ loan_id: "SM-1001", errors: ["DOFD_REQUIRED"], routed_to: "credit-reporting", sla: "same_day", resolution: "omitted_from_file", php_next_month: "D" }]);
  assert.deepEqual(b.omitted, [{ loan_id: "SM-1001", reason: "hard_error:DOFD_REQUIRED" }]);
  assert.deepEqual(b.included.map((x) => x.loan_id), ["SM-1002"], "excluded from the file, never furnished wrong (§1681s-2(a)(1)(A))");
  assert.ok(b.files.every((f) => f.header.record_count === 1 && f.trailer.total_base_records === 1 && f.records.length === 1));
  assert.equal(events.ofType("credit.cycle.exception").length, 1); assert.equal(events.ofType("credit.cycle.exception")[0]!.loanId, "SM-1001");
  assert.deepEqual(events.ofType("credit.cycle.snapshot_completed")[0]!.payload.exceptions, [{ loan_id: "SM-1001", errors: ["DOFD_REQUIRED"] }]);
  // unresolved → next month's PHP position 1 (April) is `D`; the rest of the history is carried unchanged
  const nextPhp = phpAfterOmission(bad);
  assert.equal(nextPhp[0], "D"); assert.equal(nextPhp.slice(1), bad.php.slice(0, 23));
  assert.equal(carryPhp({ php: bad.php, status: null, dofd: null, omitted: true })[0], "D");
  // the runner refuses to furnish a record whose hard error is unresolved
  assert.throws(() => runner.transmit({ ...b, included: [bad] }, "2027-05-03T14:00:00.000Z"), (e: unknown) => e instanceof CreditReportingRefused && e.code === "UNRESOLVED_HARD_ERROR");
  assert.equal(events.ofType("metro2.file.transmitted").length, 0, "a refusal writes nothing");
  // other rule-9 hard errors: a missing / malformed MIN (K3 on every loan), 11 with a DOFD, a closed status with an amount past due
  assert.ok(validateSnapshot({ ...ok, k3: { ...ok.k3, min: null } }).includes("K3_MIN_MISSING"));
  assert.ok(validateSnapshot({ ...ok, k3: { ...ok.k3, min: "12345" } }).includes("MIN_NOT_18_DIGITS"));
  assert.ok(validateSnapshot({ ...ok, account_status: "11", dofd: D("2027-02-01") }).includes("STATUS_11_WITH_DOFD"));
});

test("8.1-T10: (anomaly hold) Given 3% of records improve status without payment/workout events, then the cycle is `held` and only `officer` can release it.", () => {
  const recs = Array.from({ length: 100 }, (_, i) => ({ loan_id: `L${i}`, prior_status: "71" as const, status: i < 3 ? ("11" as const) : ("71" as const), explained_by_event: false, dofd_moved_later: false, deleted: false }));
  const g = anomalyGate(recs);
  assert.ok(g.held); assert.match(g.reasons[0]!, /improvements 3\.00%/);
  assert.equal(anomalyGate(recs.map((r) => ({ ...r, explained_by_event: true }))).held, false, "explained by a payment/workout event → no hold");
  assert.equal(anomalyGate(recs.map((r, i) => (i === 2 ? { ...r, status: "71" as const } : r))).held, false, "2% is under the threshold");
  // …and only `officer` can release it: the agent's and an analyst's releases are refused, so is transmission; the officer's release validates the cycle.
  const apr = aprSnapshot();
  const records = Array.from({ length: 100 }, (_, i) => ({ snapshot: i < 3 ? { ...apr, loan_id: `L${i}`, account_status: "11" as const, dofd: null, amount_past_due_cents: 0n } : { ...apr, loan_id: `L${i}`, account_status: "71" as const }, prior_status: "71" as const, explained_by_event: false }));
  const events = new MemoryEventStore(new FixedClock("2027-05-01T05:05:00.000Z"));
  const runner = new CreditCycleRunner(events, AGENT);
  const held = runner.build({ cycle_id: "2027-04", as_of: D("2027-04-30"), records, config: CONFIG });
  assert.equal(held.status, "held"); assert.match(held.held_reasons[0]!, /improvements 3\.00%/);
  assert.deepEqual(events.ofType("credit.cycle.held").map((e) => e.payload.release_requires), ["officer"]);
  assert.throws(() => runner.release(held, AGENT, "looks fine"), (e: unknown) => e instanceof CreditReportingRefused && e.code === "OFFICER_REQUIRED");
  assert.throws(() => runner.release(held, ANALYST, "looks fine"), (e: unknown) => e instanceof CreditReportingRefused && e.code === "OFFICER_REQUIRED");
  assert.throws(() => runner.transmit(held, "2027-05-03T14:00:00.000Z"), (e: unknown) => e instanceof CreditReportingRefused && e.code === "CYCLE_HELD");
  assert.equal(events.ofType("credit.cycle.released").length + events.ofType("metro2.file.transmitted").length, 0, "a refusal writes nothing");
  const released = runner.release(held, OFFICER, "improvements traced to the March lockbox re-post");
  assert.equal(released.status, "validated"); assert.equal(released.approved_by, "u-officer");
  assert.equal(events.ofType("credit.cycle.released")[0]!.actor.role, "officer");
  assert.equal(runner.transmit(released, "2027-05-04T14:00:00.000Z").transmitted.length, 4);
});

test("8.1-T11: (transmission deadlines) Given `as_of_date` 2027-01-31 and a servicer holiday on Feb 2, then BD3 = 2027-02-04; the hard stop is 2027-02-10.", () => {
  const closedFeb2 = servicerCalendar({ closures: [D("2027-02-02")] });
  const c = transmissionClocks(D("2027-01-31"), closedFeb2);
  assert.equal(c.target, D("2027-02-04"), "Sun 01-31 → Mon 02-01, (Tue 02-02 closed), Wed 02-03, Thu 02-04");
  assert.equal(c.hard_stop, D("2027-02-10"), "as_of + 10 calendar days");
  assert.equal(transmissionClocks(D("2027-01-31")).target, D("2027-02-03"), "without the closure BD3 is Wed 02-03");
  // the registry rows on the engine with that servicer calendar: SM_METRO2_TRANSMIT_ALL4_BD3 / _HARD_CD10 anchor on `as_of_date`
  const clock = new FixedClock("2027-02-01T05:05:00.000Z");
  const events = new MemoryEventStore(clock);
  const engine = engineFor(events, { ...defaultCalendars, business_days_servicer: closedFeb2 });
  const runner = new CreditCycleRunner(events, AGENT);
  runner.open("2027-01", D("2027-01-31"));
  const bd3 = armed(engine, "SM_METRO2_TRANSMIT_ALL4_BD3")[0]!, cd10 = armed(engine, "SM_METRO2_TRANSMIT_HARD_CD10")[0]!;
  assert.equal(bd3.anchorDate, D("2027-01-31")); assert.equal(bd3.dueDate, D("2027-02-04")); assert.equal(cd10.dueDate, D("2027-02-10"));
  // missing BD3 escalates `officer` sev-2; the hard stop still stands (sev-1)
  const breaches = engine.evaluate("2027-02-05T12:00:00.000Z");
  assert.deepEqual(breaches.map((b) => [b.instance.code, b.severity, [...b.escalateTo]]), [["SM_METRO2_TRANSMIT_ALL4_BD3", 2, ["officer"]]]);
  assert.equal(REG.get("SM_METRO2_TRANSMIT_HARD_CD10")!.severity.level, 1);
  const b = runner.build({ cycle_id: "2027-01", as_of: D("2027-01-31"), records: [{ snapshot: snap("SM-1001"), b1_on_file: true }], config: CONFIG });
  clock.set("2027-02-08T14:00:00.000Z");
  const t = runner.transmit(b, "2027-02-08T14:00:00.000Z");
  assert.equal(t.transmitted_on, D("2027-02-08"));
  assert.equal(engine.byCode("SM_METRO2_TRANSMIT_ALL4_BD3")[0]!.status, "satisfied_late");
  assert.equal(engine.byCode("SM_METRO2_TRANSMIT_HARD_CD10")[0]!.status, "satisfied", "sent before the 02-10 hard stop");
});

test("8.1-T12: (ack/reject loop) Given Experian's Metric Report lists 12 rejected records for invalid MIN, then `metro2_ack_items` rows exist, the agent corrects the MIN from `loans`, resubmits/AUDs within 5 BD, and the items resolve.", () => {
  const rejects = Array.from({ length: 12 }, (_, i) => ({ line: 100 + i, code: "INVALID_MIN", message: "Mortgage Identification Number invalid", loan_id: `L-${i + 1}`, field: "min" }));
  const loans = Object.fromEntries(rejects.map((r, i) => [r.loan_id, { min: `10001234567890${String(1000 + i).slice(-4)}`, fnma_loan_number: `12345678${String(10 + i)}` }]));
  const open = ackRejectLoop({ bureau: "experian", file_id: "F-2027-09-EXP", received_on: D("2027-10-05"), rejects, loans });
  assert.equal(open.items.length, 12); assert.ok(open.items.every((i) => i.classification === "data" && i.status === "corrected" && i.correction!.field === "min" && i.correction!.source === "loans"));
  assert.equal(open.resubmit_by, "2027-10-13");   // 5 servicer BD: Oct 6, 7, 8, 12, 13 (Columbus Day Oct 11 closed)
  assert.equal(open.via, "aud"); assert.equal(open.resolved, false);
  const done = ackRejectLoop({ bureau: "experian", file_id: "F-2027-09-EXP", received_on: D("2027-10-05"), rejects, loans, resubmitted_on: D("2027-10-08") });
  assert.equal(done.resolved, true); assert.deepEqual(done.unresolved, []); assert.ok(done.items.every((i) => i.status === "resolved"));
});

test("8.1-T13: (negative-information notice) Given a loan boarded without B-1 evidence that is furnished 71 on 2027-03-03, then a B-2 notice is mailed by 2027-04-02; given B-1 evidence on the hello notice, no B-2 is sent.", async () => {
  assert.equal(negativeInfoNoticeDue(D("2027-03-03"), false), D("2027-04-02")); assert.equal(negativeInfoNoticeDue(D("2027-03-03"), true), null);
  const clock = new FixedClock("2027-03-01T05:05:00.000Z");
  const events = new MemoryEventStore(clock);
  const engine = engineFor(events);
  const reg = buildRegistry(); publishAuthored(reg);
  const notices = new NoticeService({ registry: reg, events, clock, printMail: new FakePrintMail(), edelivery: new FakeEdelivery() });
  // SM-1002 boarded 2027-02-10 with no B-1 evidence; SM-1003 the same but the hello notice (1.3) carried the B-1 block; SM-1004 no B-1 either.
  events.append({ type: "notice.sent", loanId: "SM-1003", actor: { kind: "agent", id: "disclosures" }, payload: { notice_id: "n-hello-1003", template: "NTC_REGX_1024_33B_HELLO_MS2", carries: [B1_TEMPLATE], channels: [{ party_id: "A", channel: "mail_first_class", satisfies_timer: true }] } });
  assert.equal(b1EvidenceOnFile(events.byLoan("SM-1002")), false); assert.equal(b1EvidenceOnFile(events.byLoan("SM-1003")), true);
  // Jan-1 unpaid → 58 days at 02-28 → 71 (negative information)
  const led = ledger("2026-12-01");
  const dq = (loan: string) => buildSnapshot(state("2027-02-28", led, handoffHistory("0".repeat(24), null, "11"), { loan_id: loan, payments_in_month_cents: 0n }));
  assert.equal(dq("SM-1002").account_status, "71");
  const runner = new CreditCycleRunner(events, AGENT);
  runner.open("2027-02", D("2027-02-28"));
  const b = runner.build({ cycle_id: "2027-02", as_of: D("2027-02-28"), records: ["SM-1002", "SM-1003", "SM-1004"].map((loan) => ({ snapshot: dq(loan), b1_on_file: b1EvidenceOnFile(events.byLoan(loan)) })), config: CONFIG });
  assert.deepEqual([...b.negative_information].sort(), ["SM-1002", "SM-1003", "SM-1004"]); assert.deepEqual([...b.b1_on_file], ["SM-1003"]);
  clock.set("2027-03-03T14:00:00.000Z");
  runner.transmit(b, "2027-03-03T14:00:00.000Z");
  // FCRA_1681S2A7_NEG_INFO_NOTICE_30 arms per loan furnished with negative information and no B-1 evidence: 30 calendar days from the transmission
  const neg = armed(engine, "FCRA_1681S2A7_NEG_INFO_NOTICE_30");
  assert.deepEqual(neg.map((t) => [t.loanId, t.dueDate]).sort(), [["SM-1002", D("2027-04-02")], ["SM-1004", D("2027-04-02")]]);
  const plan = b2Plan(b, "2027-03-03T14:00:00.000Z");
  assert.deepEqual(plan, [{ loan_id: "SM-1002", first_furnished_on: D("2027-03-03"), mail_by: D("2027-04-02"), account_status: "71" }, { loan_id: "SM-1004", first_furnished_on: D("2027-03-03"), mail_by: D("2027-04-02"), account_status: "71" }]);
  assert.ok(!plan.some((p) => p.loan_id === "SM-1003"), "B-1 evidence on the hello notice → no B-2");
  // the B-2 for SM-1002 is mailed on 03-20 through the Notice Registry (Model B-2 text; within-30 checklist) → `notice.sent{template=NTC_FCRA_1681S2A7_B2}` satisfies the timer
  const contact = { servicer_phone: "(800) 555-0100", servicer_address: "PO Box 1, Testville TX 75001", recipients: () => [{ partyId: "A", name: "Ann Borrower", mailingAddress: "1 Test St, Testville TX 75001" }], account_last4: () => "1002" };
  clock.set("2027-03-20T14:00:00.000Z");
  const mailed = await mailB2Notices(notices, plan.filter((p) => p.loan_id === "SM-1002"), { ...contact, sent_on: D("2027-03-20") });
  assert.equal(mailed.length, 1); assert.equal(mailed[0]!.status, "sent"); assert.equal(mailed[0]!.days_after_furnishing, 17);
  const n = notices.get(mailed[0]!.notice_id);
  assert.equal(n.templateCode, B2_TEMPLATE); assert.ok(n.rendered.text.includes("We have told a credit bureau about a late payment, missed payment or other default on your account."));
  assert.deepEqual(n.deliveries.map((x) => x.channel), ["mail_first_class"], "B-2 goes first-class mail absent esign consent for class fcra_notices");
  const sent = events.ofType("notice.sent").filter((e) => e.payload.template === B2_TEMPLATE);
  assert.equal(sent.length, 1); assert.equal(sent[0]!.loanId, "SM-1002");
  assert.deepEqual(satisfied(engine, "FCRA_1681S2A7_NEG_INFO_NOTICE_30").map((t) => t.loanId), ["SM-1002"]);
  assert.deepEqual(armed(engine, "FCRA_1681S2A7_NEG_INFO_NOTICE_30").map((t) => t.loanId), ["SM-1004"]);
  // a B-2 attempted after day 30 is held by the checklist (`within-30`, §1681s-2(a)(7)(B)(i)), never mailed, and the timer breaches → escalate `officer` sev-1
  clock.set("2027-04-05T14:00:00.000Z");
  const late = await mailB2Notices(notices, plan.filter((p) => p.loan_id === "SM-1004"), { ...contact, account_last4: () => "1004", sent_on: D("2027-04-05") });
  assert.equal(late[0]!.status, "held"); assert.equal(late[0]!.days_after_furnishing, 33);
  assert.match(notices.get(late[0]!.notice_id).heldReason!, /within-30/);
  await assert.rejects(notices.send(late[0]!.notice_id), NoticeHeld);
  assert.equal(events.ofType("notice.sent").filter((e) => e.payload.template === B2_TEMPLATE).length, 1);
  const breaches = engine.evaluate("2027-04-05T14:00:00.000Z");
  assert.deepEqual(breaches.filter((x) => x.instance.code === "FCRA_1681S2A7_NEG_INFO_NOTICE_30").map((x) => [x.instance.loanId, x.severity, [...x.escalateTo]]), [["SM-1004", 1, ["officer"]]]);
  assert.equal(breaches.filter((x) => x.instance.code === "SM_METRO2_ACK_EXPECTED_BD").length, 4, "no bureau acknowledgment ingested by 03-10 → the four per-file ack clocks breach too (escalate human_agent)");
});

test("8.1-T14: (DOFD never later) Given a correction attempting to move DOFD from 02012027 to 03012027 without evidence, then the command is rejected `DOFD_REAGE_BLOCKED`.", () => {
  const events = new MemoryEventStore(new FixedClock("2027-04-05T14:00:00.000Z"));
  const engine = engineFor(events);
  const runner = new CreditCycleRunner(events, AGENT);
  const later = { loan_id: "SM-1001", source: "qc" as const, fields_changed: [{ field: "date_of_first_delinquency", before: "2027-02-01", after: "2027-03-01" }], determined_on: D("2027-04-05") };
  assert.throws(() => runner.createCorrection(later), (e: unknown) => e instanceof DofdReageBlocked && e.message.startsWith("DOFD_REAGE_BLOCKED") && e.from === D("2027-02-01") && e.to === D("2027-03-01"));
  assert.equal(events.ofType("credit.correction.created").length, 0, "the rejected command writes nothing");
  assert.equal(armed(engine, "FCRA_1681S2A2_CORRECTION_PROMPT_BD2").length, 0);
  assert.throws(() => correctDofd(D("2027-02-01"), D("2027-03-01"), null), DofdReageBlocked);
  // with evidence that the earlier date was itself wrong (e.g. the misposted lockbox deposit) the move is a correction row: AUD within 2 BD
  const evidenced = runner.createCorrection({ ...later, evidence_document_id: "doc-lockbox-2027-02-05" });
  assert.equal(evidenced.correction.aud_due, D("2027-04-07"));
  assert.equal(armed(engine, "FCRA_1681S2A2_CORRECTION_PROMPT_BD2")[0]!.dueDate, D("2027-04-07"));
  assert.equal(events.ofType("credit.correction.created")[0]!.payload.evidence_document_id, "doc-lockbox-2027-02-05");
  assert.equal(correctDofd(D("2027-02-01"), D("2027-03-01"), "doc-lockbox-2027-02-05"), D("2027-03-01"));
  // guardrail: PHP history, Date Opened and DOFD change only through a corrections row with evidence — an earlier DOFD too
  for (const field of ["payment_history_profile", "date_opened"]) assert.throws(() => runner.createCorrection({ loan_id: "SM-1001", source: "self_identified", fields_changed: [{ field, before: "x", after: "y" }], determined_on: D("2027-04-05") }), (e: unknown) => e instanceof CreditReportingRefused && e.code === "CORRECTION_NEEDS_EVIDENCE");
  assert.throws(() => runner.createCorrection({ loan_id: "SM-1001", source: "qc", fields_changed: [{ field: "dofd", before: "2027-03-01", after: "2027-02-01" }], determined_on: D("2027-04-05") }), (e: unknown) => e instanceof CreditReportingRefused && e.code === "CORRECTION_NEEDS_EVIDENCE");
  assert.equal(events.ofType("credit.correction.created").length, 1);
});

test("8.1-T15: (boarding history) Given a transferor hand-off with PHP `000010000000000000000000` and DOFD blank, then the first cycle carries that PHP and DOFD blank; given no hand-off, PHP is `B` × 24.", () => {
  const handoff = handoffHistory("000010000000000000000000", null, "11");
  assert.deepEqual(handoff, { php: "000010000000000000000000", status: "11", dofd: null });
  const s = buildSnapshot(state("2027-01-31", ledger("2027-01-01"), handoff));
  // The hand-off is the transferor's prior-month snapshot: our first cycle carries that PHP shifted one position with the
  // transferor's last status (11 → `0`) in position 1 (rule 4: position 1 = the month before as_of, never recomputed).
  assert.equal(s.php, "0" + "000010000000000000000000".slice(0, 23));
  assert.equal(s.php.slice(1), "000010000000000000000000".slice(0, 23), "the hand-off history is carried, not recomputed from today's ledger");
  assert.equal(s.dofd, null); assert.equal(renderBase(s).date_of_first_delinquency, "00000000", "DOFD blank carried from the hand-off (the loan is current)");
  assert.deepEqual(validateSnapshot(s), []);
  // no hand-off → `B` × 24 (rule 14: missing PHP months are `B`), and a short hand-off is padded with `B`
  assert.equal(carryPhp(null), "B".repeat(24));
  assert.equal(handoffHistory(null, null, null).php, "B".repeat(24));
  assert.equal(handoffHistory("0000", null, "11").php, "0000" + "B".repeat(20));
  const noHistory = buildSnapshot(state("2027-01-31", ledger("2027-01-01"), null));
  assert.equal(noHistory.php, "B".repeat(24));
  // rule 14 / 8.1-Q8: the boarding month is reported by Supermortgage when the transfer date is on or before the 15th
  assert.equal(boardingMonthReporter(D("2027-02-10")), "supermortgage"); assert.equal(boardingMonthReporter(D("2027-02-15")), "supermortgage"); assert.equal(boardingMonthReporter(D("2027-02-20")), "transferor");
});

test("8.1-T16: (successor not furnished) Given a confirmed successor in interest who has not assumed, then no J1/J2 segment is generated for the successor.", () => {
  const s = buildSnapshot(state("2027-01-31", ledger("2027-01-01"), JAN_PRIOR, {
    consumers: [
      { party_id: "A", position: 1, same_address_as_base: true, liability: "joint" },
      { party_id: "B", position: 2, same_address_as_base: false, liability: "joint" },
      { party_id: "S", position: 3, same_address_as_base: true, liability: "joint", successor_in_interest: true },
      { party_id: "R", position: 4, same_address_as_base: true, liability: "joint", released: true },
    ],
  }));
  assert.ok(!s.consumers.some((c) => c.party_id === "S"), "a confirmed successor who has not assumed is not furnished (Reg V accuracy: liability for the account)");
  assert.deepEqual(s.consumers.map((c) => [c.party_id, c.segment, c.ecoa, c.special_comment]), [["A", "base", "2", ""], ["B", "J2", "2", ""], ["R", "J1", "T", "H"]]);
  // the same file renders one Base and two associated-consumer segments — none for the successor
  const files = cycleFiles({ cycle_id: "2027-01", snapshots: [s], config: CONFIG });
  assert.ok(files.every((f) => f.header.record_count === 1));
  // an assumed successor is an obligor: added as a consumer from the assumption date, the released borrower gets ECOA T + H
  const assumed = buildSnapshot(state("2027-01-31", ledger("2027-01-01"), JAN_PRIOR, { consumers: [{ party_id: "S", position: 1, same_address_as_base: true, liability: "individual" }, { party_id: "A", position: 2, same_address_as_base: true, liability: "individual", released: true }] }));
  assert.deepEqual(assumed.consumers.map((c) => [c.party_id, c.segment, c.ecoa, c.special_comment]), [["S", "base", "1", ""], ["A", "J1", "T", "H"]]);
});

test("8.1-T17: (FDCPA gate) Given a loan boarded in default with no contact yet, then it is omitted from the cycle until a live contact or 14 days after a validation notice without undeliverability.", () => {
  const noContact = fdcpaCycleInclusion({ boarded_in_default: true, gate: { live_contact_on: null, validation_notice_sent_on: null, undeliverable_on: null }, cycle_as_of: D("2027-01-31") });
  assert.equal(noContact.include, false); assert.equal(noContact.omit_reason, "fdcpa_pre_furnishing_gate"); assert.equal(noContact.php_char_for_omitted_month, "D");
  const live = fdcpaCycleInclusion({ boarded_in_default: true, gate: { live_contact_on: D("2027-01-20"), validation_notice_sent_on: null, undeliverable_on: null }, cycle_as_of: D("2027-01-31") });
  assert.equal(live.include, true); assert.equal(live.gate_opens_on, "2027-01-20");
  const letter = fdcpaCycleInclusion({ boarded_in_default: true, gate: { live_contact_on: null, validation_notice_sent_on: D("2027-01-10"), undeliverable_on: null }, cycle_as_of: D("2027-01-31") });
  assert.equal(letter.gate_opens_on, "2027-01-24"); assert.equal(letter.include, true);                    // 14 days after the validation notice, no undeliverability
  assert.equal(fdcpaCycleInclusion({ boarded_in_default: true, gate: { live_contact_on: null, validation_notice_sent_on: D("2027-01-10"), undeliverable_on: D("2027-01-15") }, cycle_as_of: D("2027-01-31") }).include, false);
  // FDCPA_1006_30A_PRE_FURNISH_GATE on the engine: `loan.boarded{fdcpa_debt_collector_flag=true}` (1.1) arms the gate; the cycle omits the loan while it is closed;
  // 11.4's `fdcpa.furnishing_gate.opened` (validation notice mailed 01-10 + 14 days, no undeliverability) opens it.
  const clock = new FixedClock("2027-01-05T15:00:00.000Z");
  const events = new MemoryEventStore(clock);
  const engine = engineFor(events);
  const loanId = "SM-2001";
  events.append({ type: "loan.boarded", loanId, aggregate: { kind: "transfer_batch", id: "B-2027-01-05" }, actor: BOARDING, payload: { loan_id: loanId, fnma_loan_number: "1234567891", transfer_date: "2027-01-05", min: "100012345678901235", regx_days_delinquent: 45, default_status_at_boarding: true, fdcpa_debt_collector_flag: true } });
  events.append({ type: "loan.boarded", loanId: "SM-2002", aggregate: { kind: "transfer_batch", id: "B-2027-01-05" }, actor: BOARDING, payload: { loan_id: "SM-2002", transfer_date: "2027-01-05", regx_days_delinquent: 0, default_status_at_boarding: false, fdcpa_debt_collector_flag: false } });
  const gate = armed(engine, "FDCPA_1006_30A_PRE_FURNISH_GATE");
  assert.deepEqual(gate.map((t) => [t.loanId, t.dueDate ?? null, t.status]), [[loanId, null, "armed"]], "a not_before_gate: armed with no due date, only for the debt-collector loan");
  assert.deepEqual(fdcpaGateState(events.byLoan(loanId)), { boarded_in_default: true, gate: { live_contact_on: null, validation_notice_sent_on: null, undeliverable_on: null }, opened_on: null });
  assert.equal(fdcpaGateState(events.byLoan("SM-2002")).boarded_in_default, false);
  const dq = { ...aprSnapshot(), loan_id: loanId, as_of: D("2027-01-31") };
  const closed = buildCycle({ cycle_id: "2027-01", as_of: D("2027-01-31"), records: [{ snapshot: dq, fdcpa: fdcpaCycleInput(events.byLoan(loanId)) }, { snapshot: snap("SM-2002"), fdcpa: fdcpaCycleInput(events.byLoan("SM-2002")) }], config: CONFIG });
  assert.deepEqual(closed.omitted, [{ loan_id: loanId, reason: "fdcpa_pre_furnishing_gate" }]); assert.deepEqual(closed.included.map((s) => s.loan_id), ["SM-2002"]);
  assert.equal(phpAfterOmission(dq)[0], "D", "the omitted month renders D in the PHP thereafter");
  // 11.4: validation notice mailed 01-10; the nightly sweep opens the furnishing gate on 01-24
  const st = fdcpaStatusAtBoarding(loanId, D("2027-01-05"), { regx_days_delinquent_at_transfer: 45, bk_active: false, fc_active: false, accelerated: false });
  assert.equal(st.status.debt_collector, true);
  for (const e of recordValidationSent(st.status, { sent_on: D("2027-01-10"), channel: "mail" })) events.append({ type: e.type, loanId, actor: EI, payload: e.payload });
  assert.deepEqual(fdcpaGateState(events.byLoan(loanId)).gate, { live_contact_on: null, validation_notice_sent_on: D("2027-01-10"), undeliverable_on: null });
  assert.deepEqual(fdcpaSweep(st.status, D("2027-01-23")).filter((e) => e.type === "fdcpa.furnishing_gate.opened"), [], "day 13: still closed");
  assert.equal(engine.byCode("FDCPA_1006_30A_PRE_FURNISH_GATE")[0]!.status, "armed");
  const opened = fdcpaSweep(st.status, D("2027-01-24")).filter((e) => e.type === "fdcpa.furnishing_gate.opened");
  assert.equal(opened.length, 1); assert.equal(opened[0]!.payload.furnishing_gate_open_at, D("2027-01-24"));
  clock.set("2027-01-24T05:00:00.000Z");
  for (const e of opened) events.append({ type: e.type, loanId, actor: EI, payload: e.payload });
  assert.equal(engine.byCode("FDCPA_1006_30A_PRE_FURNISH_GATE")[0]!.status, "satisfied");
  assert.equal(fdcpaGateState(events.byLoan(loanId)).opened_on, D("2027-01-24"));
  const open = buildCycle({ cycle_id: "2027-01", as_of: D("2027-01-31"), records: [{ snapshot: dq, fdcpa: fdcpaCycleInput(events.byLoan(loanId)) }], config: CONFIG });
  assert.deepEqual(open.omitted, []); assert.deepEqual(open.included.map((s) => s.loan_id), [loanId]);
  // a live conversation opens the gate the same day
  const st2 = fdcpaStatusAtBoarding("SM-2003", D("2027-01-05"), { regx_days_delinquent_at_transfer: 45, bk_active: false, fc_active: false, accelerated: false });
  const conv = recordConversation(st2.status, D("2027-01-12")).find((e) => e.type === "fdcpa.furnishing_gate.opened")!;
  assert.equal(conv.payload.furnishing_gate_open_at, D("2027-01-12"));
  assert.ok(eventMatches(REG.get("FDCPA_1006_30A_PRE_FURNISH_GATE")!.satisfiedPattern!, events.append({ type: conv.type, loanId: "SM-2003", actor: EI, payload: conv.payload })));
});

test("8.1-T18: (four bureaus) Given any cycle, then exactly four files exist and Innovis is not skipped.", () => {
  const config = { equifax: { program_identifier: "EFX-PROG", subscriber_code: "EFX123", file_naming: "SM_{cycle}_{bureau}.m2" }, experian: { program_identifier: "EXP-PROG", subscriber_code: "EXP123", file_naming: "SM_{cycle}_{bureau}.m2" }, transunion: { program_identifier: "TU-PROG", subscriber_code: "TU123", file_naming: "SM_{cycle}_{bureau}.m2" }, innovis: { program_identifier: "INV-PROG", subscriber_code: "INV123", file_naming: "SM_{cycle}_{bureau}.m2" } };
  const files = cycleFiles({ cycle_id: "2027-01", snapshots: [snap("SM-1001"), snap("SM-1002")], config });
  assert.equal(files.length, 4); assert.deepEqual(files.map((f) => f.bureau).sort(), ["equifax", "experian", "innovis", "transunion"]);
  assert.ok(files.some((f) => f.bureau === "innovis" && f.header.identification_number === "INV123"));
  assert.ok(files.every((f) => f.header.record_count === 2 && f.trailer.total_base_records === 2 && JSON.stringify(f.records) === JSON.stringify(files[0]!.records)));
  assert.equal(files.find((f) => f.bureau === "innovis")!.file_name, "SM_2027-01_innovis.m2");
  assert.ok(files.every((f) => /^[0-9a-f]{64}$/.test(f.hash)), "every file carries its SHA-256 (rule 11 idempotency key)");
});

test("8.1-T19: (rounding) Given Amount Past Due $4,919.10, then the field is 000004919 (truncation); switching `policy.metro2_rounding='round'` yields 000004919 for .10 and 000004920 for $4,919.55.", () => {
  const apd = cents("4919.10");
  assert.equal(apd, PITI * 2n, "two unpaid PITI installments (rule 13, 03-31)");
  assert.equal(metro2Money(apd), "000004919");
  assert.equal(metro2Money(apd, "truncate"), "000004919");
  assert.equal(metro2Money(apd, "round"), "000004919");
  assert.equal(metro2Money(cents("4919.55"), "round"), "000004920");
  assert.equal(metro2Money(cents("4919.55"), "truncate"), "000004919");
  // the policy flows through the rendered Base record
  const s = { ...aprSnapshot(), amount_past_due_cents: cents("4919.55") };
  assert.equal(renderBase(s).amount_past_due, "000004919"); assert.equal(renderBase(s, "round").amount_past_due, "000004920");
  assert.equal(renderBase({ ...s, amount_past_due_cents: apd }, "round").amount_past_due, "000004919");
});

test("8.1 SM_METRO2_ANNUAL_POLICY_REVIEW_365: the officer's sign-off appends `credit.policy.reviewed`, which arms the 12-month clock from `reviewed_on`; the next review satisfies it; the agent cannot sign", () => {
  const clock = new FixedClock("2026-09-15T15:00:00.000Z");
  const events = new MemoryEventStore(clock);
  const engine = engineFor(events);
  assert.throws(() => recordPolicyReview(events, { reviewed_on: D("2026-09-10"), signer: AGENT, policy_version: "fcra.regv.2026-09", program_document_id: "doc-appx-e-2026" }), (e: unknown) => e instanceof CreditReportingRefused && e.code === "OFFICER_REQUIRED");
  assert.throws(() => recordPolicyReview(events, { reviewed_on: D("2026-09-10"), signer: ANALYST, policy_version: "fcra.regv.2026-09", program_document_id: "doc-appx-e-2026" }), (e: unknown) => e instanceof CreditReportingRefused && e.code === "OFFICER_REQUIRED");
  assert.throws(() => recordPolicyReview(events, { reviewed_on: D("2026-09-10"), signer: OFFICER, policy_version: "", program_document_id: "doc-appx-e-2026" }), RangeError);
  assert.equal(events.all().length, 0, "a refusal writes nothing");
  assert.deepEqual(policyReviewStatus(events, D("2026-09-15")), { last_reviewed_on: null, next_review_due: null, overdue: false });
  const r = recordPolicyReview(events, { reviewed_on: D("2026-09-10"), signer: OFFICER, policy_version: "fcra.regv.2026-09", program_document_id: "doc-appx-e-2026", scope: ["dispute rate by field", "reject rate by bureau", "correction root causes"] });
  assert.equal(r.next_review_due, D("2027-09-10")); assert.equal(nextPolicyReviewDue(D("2026-09-10")), D("2027-09-10")); assert.equal(r.signed_by_role, "officer");
  const ev = events.ofType("credit.policy.reviewed");
  assert.equal(ev.length, 1); assert.deepEqual(ev[0]!.aggregate, POLICY_REVIEW_SUBJECT); assert.equal(ev[0]!.payload.signed_by, "u-officer");
  const inst = armed(engine, "SM_METRO2_ANNUAL_POLICY_REVIEW_365");
  assert.equal(inst.length, 1); assert.equal(inst[0]!.anchorDate, D("2026-09-10"), "anchored on the review date, not the event's wall-clock date"); assert.equal(inst[0]!.dueDate, D("2027-09-10"));
  assert.deepEqual(policyReviewStatus(events, D("2027-09-11")), { last_reviewed_on: D("2026-09-10"), next_review_due: D("2027-09-10"), overdue: true });
  // the next year's sign-off is the satisfying event (matched against the row's pattern on a side store: the engine re-arms a
  // recurring row from its satisfying event while iterating its live instances, which never terminates when trigger = satisfier)
  const side = new MemoryEventStore(new FixedClock("2027-09-01T15:00:00.000Z"));
  recordPolicyReview(side, { reviewed_on: D("2027-09-01"), signer: OFFICER, policy_version: "fcra.regv.2027-09", program_document_id: "doc-appx-e-2027" });
  const def = REG.get("SM_METRO2_ANNUAL_POLICY_REVIEW_365")!;
  assert.ok(eventMatches(def.satisfiedPattern!, side.ofType("credit.policy.reviewed")[0]!));
  assert.ok(eventMatches(def.triggerPattern!, side.ofType("credit.policy.reviewed")[0]!), "recurring: the same sign-off arms the next 12-month clock");
  assert.equal(eventMatches(def.satisfiedPattern!, side.append({ type: "credit.cycle.validated", actor: AGENT, payload: {} })), false);
  // breach: no review by 2027-09-10 → escalate `officer` (Reg V §1022.42(c))
  const breaches = engine.evaluate("2027-09-11T12:00:00.000Z");
  assert.deepEqual(breaches.map((b) => [b.instance.code, [...b.escalateTo]]), [["SM_METRO2_ANNUAL_POLICY_REVIEW_365", ["officer"]]]);
});

test("8.1 rule 13 worked example: $300,000.00 at 6.250% → P&I $1,847.15, escrow $612.40, PITI $2,459.55; UPB $293,063.94 after payment #23, $292,743.16 after the August payment; deferral $11,082.90 + $3,674.40 = $14,757.30", () => {
  assert.equal(levelPayment(30000000n, RATE, 360), 184715n); assert.equal(PI + ESCROW, 245955n);
  assert.equal(scheduledUpbAfter(30000000n, "6.250", 184715n, 23), 29306394n);
  assert.equal(scheduledUpbAfter(29306394n, "6.250", 184715n, 1), 29274316n);
  // deferral (12.6 nib): 6 × P&I, plus the six escrow advances, no servicing advances
  const escrowAdvances = sumCents(Array.from({ length: 6 }, () => ESCROW));
  assert.equal(nib(PI, 6, 0n, 0n), 1108290n);
  assert.equal(escrowAdvances, 367440n);
  assert.equal(nib(PI, 6, escrowAdvances, 0n), 1475730n);
  assert.equal(29274316n + nib(PI, 6, escrowAdvances, 0n), 30750046n);            // Current Balance 000307500 at 08-31
});
