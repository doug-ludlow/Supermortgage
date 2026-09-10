// 3.9 State interest-on-escrow
// spec/sections/03-escrow-administration/3-9-state-interest-on-escrow.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, addMonths, addDays } from "../../kernel/calendar/date.ts";
import { cents } from "../../kernel/money/cents.ts";
import { project, decide, newPayment, cushion, effectiveDate, anomalies } from "./analysis.ts";
const E = [{ line_type: "school_tax", amount_cents: cents("360"), disburse_on: D("2026-09-15") }, { line_type: "county_tax", amount_cents: cents("500"), disburse_on: D("2026-07-15") }, { line_type: "county_tax", amount_cents: cents("700"), disburse_on: D("2026-12-15") }];
const A = [{ line_type: "county_tax", amount_cents: cents("520"), disburse_on: D("2027-07-15") }, { line_type: "county_tax", amount_cents: cents("760"), disburse_on: D("2027-12-15") }, { line_type: "school_tax", amount_cents: cents("380"), disburse_on: D("2027-09-15") }];
void E; void A; void addMonths; void addDays; void project; void decide; void newPayment; void cushion; void effectiveDate; void anomalies;
import * as I from "./interest.ts";
import { EscrowEventLedger, nhRateFor, orRateFor, rateObservation, form1099Int, accrueDaily, recomputeOnPmiTerminated } from "./ops.ts";
import { escrowBus, ESCROW_AGENT } from "./spec-harness.ts";
import { MemoryEventStore, FixedClock, SYSTEM, eventMatches } from "../../kernel/events/index.ts";
import { TimerEngine } from "../../kernel/timers/engine.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { EscrowInterest1099Service, EscrowInterestAccrualJob, dailyAccrualExact, type Form1099IntRecord } from "./ops-3-9.ts";

test("3.9-T1: Given a NY owner-occupied 2-family loan with Q3-2027 average daily balance $1,234.56, then $6.22 is credited on 2027-09-30 with ledger and event evidence.", async () => {
  const credit = I.accrue(123_456n, I.resolveRate({ state: "NY", origination_date: D("2020-01-01") }), 92); assert.equal(credit, 622n);
  assert.equal(I.nextCreditingDate("NY", D("2027-07-01")), "2027-09-30"); assert.equal(I.creditFrequency("NY"), "quarterly_end");   // NY credits at quarter end (rule 4)
  // Through the bus on the crediting date: the rate is the statute's (2%), the ledger is the tool's balanced Dr escrow_interest_expense / Cr escrow set, and the `escrow.interest.credited` fact carries the date.
  const bus = escrowBus("L-1", "2027-09-30T15:00:00.000Z");
  const out = (await bus.run("3.9", "postInterestCredit", ESCROW_AGENT, { state: "NY", origination_date: "2020-01-01", avg_daily_balance_cents: 123_456n, days: 92 })) as { credited_cents: bigint; rate_pct: string; credited_on: string; ledger: { dr: string; cr: string; amount_cents: bigint; rule_ref: string }[]; escrow_event: { item: string; amount_cents: bigint } };
  assert.deepEqual([out.credited_cents, out.rate_pct, out.credited_on], [622n, "2", "2027-09-30"]);
  assert.deepEqual(out.ledger, [{ dr: "escrow_interest_expense", cr: "loan.escrow", amount_cents: 622n, rule_ref: "3.9 rule 4" }]); assert.deepEqual(out.escrow_event, { item: "Interest on Escrow", amount_cents: 622n });
  const ev = bus.events.ofType("escrow.interest.credited"); assert.equal(ev.length, 1); assert.deepEqual([ev[0]!.payload.amount_cents, ev[0]!.payload.credited_on, ev[0]!.payload.prorated, ev[0]!.payload.rate_pct], ["622", "2027-09-30", false, "2"]);
  const led = new EscrowEventLedger(123_456n); const e = led.emit(out.escrow_event.item, out.escrow_event.amount_cents, D(out.credited_on));
  assert.equal(e.amount_cents, 622n); assert.equal(e.balance_cents, 124_078n);
  // The agent cannot supply a rate below the 2% statutory minimum (or any rate at all — the rate in effect is resolved, not passed).
  assert.equal((await bus.refusal("3.9", "postInterestCredit", ESCROW_AGENT, { state: "NY", origination_date: "2020-01-01", balances: Array.from({ length: 92 }, () => 123_456n), rate_pct: "0.5" }))?.code, "VERIFIED_ONLY");
  assert.equal((await bus.refusal("3.9", "prorateInterest", ESCROW_AGENT, { state: "NY", origination_date: "2020-01-01", avg_daily_balance_cents: 123_456n, days: 10, rate_pct: "1" }))?.code, "VERIFIED_ONLY");
  assert.equal((await bus.refusal("3.9", "postInterestCredit", ESCROW_AGENT, { state: "TX", avg_daily_balance_cents: 123_456n, days: 92 }))?.code, "ELIGIBLE");
  assert.equal(bus.events.ofType("escrow.interest.credited").length, 1);
});
test("3.9-T2: Given a CT loan and the 2026 deposit index 0.49%, then the rate is 1.5% and $13.50 is credited on 2026-12-31 for an average $900 balance; payoff 2027-04-10 credits $3.70 before the refund.", async () => {
  assert.equal(I.resolveRate({ state: "CT", origination_date: D("2020-01-01") }, { index_pct: "0.49" }), "1.5");
  assert.equal(I.accrue(90_000n, "1.5", 365), 1_350n); assert.equal(I.accrue(90_000n, "1.5", 100), 370n); assert.equal(I.nextCreditingDate("CT", D("2026-06-15")), "2026-12-31");
  // Through the bus with the 3.9 timers: the verified deposit index is the observation the rate resolves from (floor 1.5%); at payoff the proration posts before the refund and satisfies STATE_IOE_PAYOFF_PRORATE_0, which blocks the refund until then.
  const bus = escrowBus("L-1", "2027-04-10T15:00:00.000Z", ["3.9"]);
  await bus.run("3.9", "verifyRate", ESCROW_AGENT, { state: "CT", expected_on: "2025-12-09", observed_pct: "0.49", prior_verified_pct: "1.5", accrued_at_prior_cents: 0n, base_cents: 0n, days: 0 });
  bus.events.append({ type: "loan.paid_in_full", loanId: "L-1", actor: SYSTEM, payload: { event_on: "2027-04-10", posted_on: "2027-04-10" } });
  const prorate = bus.ctx.timers.byCode("STATE_IOE_PAYOFF_PRORATE_0")[0]!; assert.equal(prorate.status, "armed"); assert.equal(prorate.dueDate, "2027-04-10");
  assert.equal((await bus.refusal("3.5", "issueRefund", ESCROW_AGENT, { kind: "payoff_refund", state: "CT", amount_cents: 61_240n, engine_amount_cents: 61_240n, payee_kind: "borrower" }))?.code, "IOE_PRORATE_FIRST");   // refund command blocked until posted
  const p = (await bus.run("3.9", "prorateInterest", ESCROW_AGENT, { state: "CT", origination_date: "2020-01-01", avg_daily_balance_cents: 90_000n, days: 100, event: "loan.paid_in_full", event_on: "2027-04-10" })) as { prorated_cents: bigint; rate_pct: string; posted_before_refund: boolean; ledger: { amount_cents: bigint }[] };
  assert.deepEqual([p.prorated_cents, p.rate_pct, p.posted_before_refund, p.ledger[0]!.amount_cents], [370n, "1.5", true, 370n]);
  assert.equal(prorate.status, "satisfied"); assert.equal(bus.events.ofType("escrow.interest.credited")[0]!.payload.prorated, true); assert.equal(bus.events.ofType("escrow.interest.prorated").length, 1);
  await bus.run("3.5", "issueRefund", ESCROW_AGENT, { kind: "payoff_refund", state: "CT", amount_cents: 61_240n, engine_amount_cents: 61_240n, payee_kind: "borrower" });
  assert.equal(((await bus.run("3.9", "prorateInterest", ESCROW_AGENT, { state: "CT", origination_date: "2020-01-01", avg_daily_balance_cents: 90_000n, days: 1 })) as { posted_before_refund: boolean }).posted_before_refund, false);   // a proration after the refund says so
});
test("3.9-T3: Given a MN loan with origination LTV 85%, then `exempt` (ltv_gt_80); with 75% and first-of-month average $1,000, then $30.00 credited annually.", () => {
  assert.equal(I.exemption({ state: "MN", origination_date: D("2020-01-01"), origination_ltv_pct: "85" }), "ltv_gt_80");
  assert.equal(I.exemption({ state: "MN", origination_date: D("2020-01-01"), origination_ltv_pct: "75" }), null); assert.equal(I.accrueMn([100_000n, 100_000n, 100_000n]), 3_000n);
});
test("3.9-T4: Given WI loans originated 1990-06-01, 2016-05-01 and 2019-03-01, then rates 5.25%, 0.17% (2026) and none respectively.", () => {
  assert.deepEqual([I.resolveRate({ state: "WI", origination_date: D("1990-06-01") }), I.resolveRate({ state: "WI", origination_date: D("2016-05-01") }), I.exemption({ state: "WI", origination_date: D("2019-03-01") })], ["5.25", "0.17", "origination_band_none"]);
  // §138.052(5) band boundaries (3.9 state table): 2/1/1983–12/31/1993 fixed 5.25%; 1/1/1994–4/17/2018 DFI variable; on/after 4/18/2018 none.
  const wi = (d: string) => ({ state: "WI", origination_date: D(d) });
  assert.deepEqual([I.wiBand(D("2018-04-17")), I.wiBand(D("2018-04-18")), I.wiBand(D("1993-12-31")), I.wiBand(D("1994-01-01")), I.wiBand(D("1983-02-01")), I.wiBand(D("1983-01-31"))], ["dfi_variable", "none", "fixed_5_25", "dfi_variable", "fixed_5_25", "none"]);
  assert.equal(I.exemption(wi("2018-06-01")), "origination_band_none"); assert.equal(I.exemption(wi("2018-04-17")), null);
  assert.equal(I.resolveRate(wi("2018-04-17")), "0.17"); assert.equal(I.resolveRate(wi("2018-04-18")), "0"); assert.equal(I.resolveRate(wi("1983-02-01")), "5.25");
  assert.equal(I.accrue(150_000n, I.resolveRate(wi("2018-06-01")), 365), 0n);                                          // a 2018-06-01 origination accrues nothing
});
test("3.9-T5: Given a RI loan with active PMI, then exempt; after PMI termination, accrual starts the next day.", async () => {
  const ri = { state: "RI", origination_date: D("2020-01-01"), pmi_active: true };
  assert.equal(I.exemption(ri), "pmi_active");
  assert.equal(I.exemption({ ...ri, pmi_active: false }), null);
  // Section 10's `pmi.terminated` recomputes eligibility: exempt through the termination date, eligible — and accruing — from the next day.
  const events = new MemoryEventStore(new FixedClock("2027-06-15T15:00:00.000Z"));
  events.append({ type: "pmi.terminated", loanId: "L-1", actor: SYSTEM, payload: { terminated_on: "2027-06-15", basis: "borrower_requested_80" } });
  const r = recomputeOnPmiTerminated(events, "L-1", ri, SYSTEM)!;
  assert.deepEqual([r.terminated_on, r.exempt_through, r.accrual_starts_on, r.exemption_after], ["2027-06-15", "2027-06-15", "2027-06-16", null]);
  assert.equal(events.ofType("escrow.interest.eligibility.recomputed")[0]!.payload.accrual_starts_on, "2027-06-16");
  const facts = { ...ri, pmi_terminated_on: D("2027-06-15") };
  assert.equal(I.exemptionOn(facts, D("2027-06-15")), "pmi_active"); assert.equal(I.exemptionOn(facts, D("2027-06-16")), null);
  const days = Array.from({ length: 11 }, (_, k) => ({ on: addDays(D("2027-06-10"), k), balance_cents: 100_000n }));                // 06-10 … 06-20 at $1,000.00
  const acc = I.accrueEligibleDays(facts, days, "0.25"); assert.deepEqual([acc.first_accrual_on, acc.days_accrued], ["2027-06-16", 5]); assert.equal(acc.accrued_cents, 5n * I.accrue(100_000n, "0.25", 1));
  assert.equal(I.accrueEligibleDays(ri, days, "0.25").days_accrued, 0);                                                                         // still insured → nothing accrues
  // The eligibility tool recomputes on the facts and dates the accrual start.
  const bus = escrowBus("L-1", "2027-06-16T15:00:00.000Z");
  const before = (await bus.run("3.9", "evaluateInterestEligibility", ESCROW_AGENT, { facts, as_of: "2027-06-15" })) as { eligible: boolean; exemption: string | null };
  const after = (await bus.run("3.9", "evaluateInterestEligibility", ESCROW_AGENT, { facts, as_of: "2027-06-16" })) as { eligible: boolean; pmi_termination: { accrual_starts_on: string } };
  assert.deepEqual([before.eligible, before.exemption, after.eligible, after.pmi_termination.accrual_starts_on], [false, "pmi_active", true, "2027-06-16"]);
  assert.equal((await bus.refusal("3.9", "postInterestCredit", ESCROW_AGENT, { ...facts, avg_daily_balance_cents: 100_000n, days: 1, as_of: "2027-06-15" }))?.code, "ELIGIBLE");
  assert.equal(((await bus.run("3.9", "postInterestCredit", ESCROW_AGENT, { ...facts, avg_daily_balance_cents: 100_000n, days: 5, as_of: "2027-06-20" })) as { credited_cents: bigint }).credited_cents, I.accrue(100_000n, "0.25", 5));   // the five eligible days, average-daily basis
});
test("3.9-T6: Given a MA loan, then only the tax share of the balance accrues at the policy rate and the annual credit is posted at least once a year.", () => {
  const f = { state: "MA", origination_date: D("2020-01-01"), tax_annual_cents: 300_000n, total_annual_cents: 420_000n };
  assert.equal(I.maTaxShare(100_000n, f), 71_429n);
  assert.equal(I.accrue(I.maTaxShare(140_000n, f), I.resolveRate(f, { policy_rate_pct: "0.25" }), 365), 250n);   // $2.50 per year, posted at least once a year
});
test("3.9-T7: Given a VT loan with escrow imposed after the borrower failed to pay taxes last year, then exempt (escrow_imposed_for_default).", () => {
  assert.equal(I.exemption({ state: "VT", origination_date: D("2020-01-01"), escrow_imposed_for_default: true }), "escrow_imposed_for_default");
});
test("3.9-T8: Given a NH loan, then the rate switches on Apr 1 and Oct 1 to the FDIC January/July savings rate observations.", () => {
  const obs = { january_pct: "0.40", july_pct: "0.45" };
  assert.deepEqual(nhRateFor(D("2027-05-10"), obs), { rate_pct: "0.40", basis: "fdic_january", switched_on: "2027-04-01" });
  assert.deepEqual(nhRateFor(D("2027-11-10"), obs), { rate_pct: "0.45", basis: "fdic_july", switched_on: "2027-10-01" });
  assert.equal(nhRateFor(D("2028-02-10"), obs).switched_on, "2027-10-01");
});
test("3.9-T9: Given a borrower with $24.88 total interest in 2027, then a 1099-INT is furnished by 2028-01-31 and e-filed by 2028-03-31; with $8.40, no form.", () => {
  assert.deepEqual(form1099Int(2_488n, 2027), { required: true, furnish_by: "2028-01-31", efile_by: "2028-03-31" });
  assert.deepEqual(form1099Int(840n, 2027), { required: false, furnish_by: null, efile_by: null });
  assert.equal(I.FORM_1099_INT_THRESHOLD_CENTS, cents("10.00")); assert.equal(I.needs1099Int(2_488n), true);
  assert.equal(form1099Int(2_488n, 2025).furnish_by, "2026-02-02");                                             // IRS_1099INT_FURNISH_0131: Sat 2026-01-31 rolls to the next federal business day
  // Through the year-end job with the whole registry armed (no process filter): four NY quarterly credits of $6.22 (worked example (a)) make the $24.88 (example (f)); the borrower with $8.40 gets no form and no timers.
  const clock = new FixedClock("2028-01-02T05:05:00.000Z"); const events = new MemoryEventStore(clock); const engine = new TimerEngine(loadOverriddenRegistry(), events);
  for (const on of ["2027-03-31", "2027-06-30", "2027-09-30", "2027-12-31"]) events.append({ type: "escrow.interest.credited", loanId: "L-1", actor: SYSTEM, payload: { state: "NY", amount_cents: "622", rate_pct: "2", credited_on: on, prorated: false } });
  events.append({ type: "escrow.interest.credited", loanId: "L-1", actor: SYSTEM, payload: { state: "NY", amount_cents: "622", rate_pct: "2", credited_on: "2026-12-31", prorated: false } });   // prior year: not in the 2027 aggregate
  events.append({ type: "escrow.interest.credited", loanId: "L-2", actor: SYSTEM, payload: { state: "CT", amount_cents: "840", rate_pct: "1.5", credited_on: "2027-12-31", prorated: false } });
  // 7.1's Form 1098 year-end close (ops-7-1.ts closeTaxYear) appends `tax_year.closed` for every loan with interest received — carrying no `source`; it arms no 1099-INT row, neither for L-7 (no escrow interest) nor for L-1 ahead of the 1099-INT close.
  const close1098 = { tax_year: 2027, tax_year_end: "2027-12-31", furnish_by: "2028-01-31", efile_by: "2028-03-31" };
  events.append({ type: "tax_year.closed", loanId: "L-7", actor: SYSTEM, payload: close1098 }); events.append({ type: "tax_year.closed", loanId: "L-1", actor: SYSTEM, payload: close1098 });
  assert.equal(engine.byCode("IRS_1099INT_FURNISH_0131").length + engine.byCode("IRS_1099INT_EFILE_0331").length, 0);
  const svc = new EscrowInterest1099Service(events);
  assert.throws(() => svc.closeTaxYear(2027, []), RangeError);
  const closed = svc.closeTaxYear(2027, [{ borrower_id: "B-1", tin_hash: "tin-1", loan_ids: ["L-1"] }, { borrower_id: "B-2", tin_hash: "tin-2", loan_ids: ["L-2"] }]);
  const [r1, r2] = closed.records as [Form1099IntRecord, Form1099IntRecord];
  assert.deepEqual([r1.total_cents, r1.required, r1.furnish_by, r1.efile_by, r1.status, r1.per_loan[0]!.credits], [2_488n, true, "2028-01-31", "2028-03-31", "aggregated", 4]);
  assert.deepEqual([r2.total_cents, r2.required, r2.furnish_by, r2.efile_by, r2.status], [840n, false, null, null, "not_required"]);
  assert.deepEqual([closed.tax_year_end, closed.reportable_loans, closed.already_closed, closed.returns, closed.information_returns_total, closed.electronic_filing_required], ["2027-12-31", ["L-1"], [], 1, 1, false]);   // the 1098 close of L-1 is not a 1099-INT close
  assert.deepEqual(events.ofType("tax_year.closed").map((e) => [e.loanId, e.payload.source ?? null]), [["L-7", null], ["L-1", null], ["L-1", "escrow_interest_1099"]]);
  assert.deepEqual(svc.closeTaxYear(2027, [{ borrower_id: "B-1", tin_hash: "tin-1", loan_ids: ["L-1"] }]).already_closed, ["L-1"]); assert.equal(events.ofType("tax_year.closed").length, 3);   // one 1099-INT close per loan and year
  // Rule 9 / T.D. 9972: "file electronically when 10+ information returns" — in the aggregate across form types (this one 1099-INT plus the servicer's nine 1098s), not per form.
  assert.deepEqual([svc.closeTaxYear(2027, [{ borrower_id: "B-2", tin_hash: "tin-2", loan_ids: ["L-2"] }], { other_information_returns: 9 }).electronic_filing_required, svc.closeTaxYear(2027, [{ borrower_id: "B-1", tin_hash: "tin-1", loan_ids: ["L-1"] }], { other_information_returns: 9 }).electronic_filing_required], [false, true]);
  assert.throws(() => svc.closeTaxYear(2027, [{ borrower_id: "B-1", tin_hash: "tin-1", loan_ids: ["L-1"] }], { other_information_returns: -1 }), RangeError);
  const furnishT = engine.byCode("IRS_1099INT_FURNISH_0131"), efileT = engine.byCode("IRS_1099INT_EFILE_0331");
  assert.deepEqual(furnishT.map((t) => [t.loanId, t.dueDate, t.anchorDate, t.status]), [["L-1", "2028-01-31", "2027-12-31", "armed"]]); assert.deepEqual(efileT.map((t) => [t.loanId, t.dueDate, t.anchorDate, t.status]), [["L-1", "2028-03-31", "2027-12-31", "armed"]]);
  // A year-end close run late (after Jan 31 / Mar 31) anchors on `tax_year_end`, not on the day the job ran: the tax year's own deadlines, already past — never next year's.
  const late = new MemoryEventStore(new FixedClock("2028-04-05T15:00:00.000Z")); const lateEngine = new TimerEngine(loadOverriddenRegistry(), late);
  for (const on of ["2027-03-31", "2027-06-30", "2027-09-30", "2027-12-31"]) late.append({ type: "escrow.interest.credited", loanId: "L-3", actor: SYSTEM, payload: { state: "NY", amount_cents: "622", rate_pct: "2", credited_on: on, prorated: false } });
  new EscrowInterest1099Service(late).closeTaxYear(2027, [{ borrower_id: "B-3", tin_hash: "tin-3", loan_ids: ["L-3"] }]);
  assert.deepEqual([lateEngine.byCode("IRS_1099INT_FURNISH_0131")[0]!.dueDate, lateEngine.byCode("IRS_1099INT_EFILE_0331")[0]!.dueDate], ["2028-01-31", "2028-03-31"]);
  assert.deepEqual(lateEngine.evaluate("2028-04-05T15:00:00.000Z").map((b) => b.instance.code).filter((c) => c.startsWith("IRS_1099INT")).sort(), ["IRS_1099INT_EFILE_0331", "IRS_1099INT_FURNISH_0131"]);   // both sev-2 breaches exist the day the late job runs
  assert.throws(() => svc.furnish(r2, { furnished_at: "2028-01-20T15:00:00.000Z", channel: "paper", delivery_evidence_id: "MAN-1" }), /no 1099-INT under \$10\.00/);
  assert.throws(() => svc.furnish({ ...r1, tin_hash: null }, { furnished_at: "2028-01-20T15:00:00.000Z", channel: "paper", delivery_evidence_id: "MAN-1" }), /solicit the TIN/);
  assert.equal(svc.furnish({ ...r1, tin_hash: null, tin_solicited: true }, { furnished_at: "2028-01-20T15:00:00.000Z", channel: "paper", delivery_evidence_id: "MAN-0" }).backup_withholding, true);   // after solicitation: furnished with backup withholding
  assert.throws(() => svc.recordFiled(r1, { filed_at: "2028-03-15T14:00:00.000Z", irs_receipt_id: "IRIS-1", irs_accepted: true, returns_in_transmittal: 12 }), /file after furnishing/);
  const fu = svc.furnish(r1, { furnished_at: "2028-01-20T15:00:00.000Z", channel: "paper", delivery_evidence_id: "MAN-2028-0117" });
  assert.deepEqual([fu.on_time, fu.record.status, fu.record.furnished_at, fu.events[0]!.type, fu.events[0]!.payload.furnished_at, fu.events[0]!.payload.total_cents], [true, "furnished", "2028-01-20T15:00:00.000Z", "tax.1099int.furnished", "2028-01-20T15:00:00.000Z", "2488"]);
  assert.equal(eventMatches(loadOverriddenRegistry().get("IRS_1099INT_FURNISH_0131")!.satisfiedPattern!, fu.events[0]!), true);
  assert.deepEqual([furnishT[0]!.status, efileT[0]!.status], ["satisfied", "armed"]);
  assert.throws(() => svc.recordFiled(fu.record, { filed_at: "2028-03-15T14:00:00.000Z", irs_receipt_id: null, irs_accepted: true, returns_in_transmittal: 12 }), /receipt id/);
  const rejected = svc.recordFiled(fu.record, { filed_at: "2028-03-15T14:00:00.000Z", irs_receipt_id: null, irs_accepted: false, rejection_reason: "TIN mismatch", returns_in_transmittal: 12 });
  assert.deepEqual([rejected.record.filed_at, rejected.record.status, efileT[0]!.status], [null, "furnished", "armed"]);                                          // a rejection does not write filed_at
  const accepted = svc.recordFiled(fu.record, { filed_at: "2028-03-20T14:00:00.000Z", irs_receipt_id: "IRIS-2028-000456", irs_accepted: true, returns_in_transmittal: 12 });
  assert.deepEqual([accepted.record.filed_at, accepted.record.status, accepted.on_time, accepted.electronic, efileT[0]!.status], ["2028-03-20T14:00:00.000Z", "filed", true, true, "satisfied"]);
  assert.equal(eventMatches(loadOverriddenRegistry().get("IRS_1099INT_EFILE_0331")!.satisfiedPattern!, rejected.events[0]!), false);
  assert.equal(engine.byCode("IRS_1099INT_FURNISH_0131").length + engine.byCode("IRS_1099INT_EFILE_0331").length, 2);                                                      // nothing armed for the $8.40 borrower
});
test("3.9-T10: Given a rate observation missing on Jan 15 for MD, then accrual continues at the prior verified rate and a sev-2 escalation exists; on verification a true-up posts the difference.", () => {
  const missing = rateObservation({ state: "MD", expected_on: D("2027-01-15"), observed_pct: null, prior_verified_pct: "0.30", accrued_at_prior_cents: 0n, base_cents: 100_000n, days: 31 });
  assert.deepEqual(missing, { rate_in_effect_pct: "0.30", escalation: "sev2", true_up_cents: 0n });
  const verified = rateObservation({ state: "MD", expected_on: D("2027-01-15"), observed_pct: "0.50", prior_verified_pct: "0.30", accrued_at_prior_cents: I.accrue(100_000n, "0.30", 31), base_cents: 100_000n, days: 31 });
  assert.equal(verified.escalation, null); assert.equal(verified.true_up_cents, I.accrue(100_000n, "0.50", 31) - I.accrue(100_000n, "0.30", 31)); assert.ok(verified.true_up_cents > 0n);
});
test("3.9-T11: Given a negative escrow balance for 20 days, then those days accrue $0.", () => {
  const balances = [...Array.from({ length: 20 }, () => -5_000n), ...Array.from({ length: 10 }, () => 100_000n)];
  assert.equal(accrueDaily(balances, "2"), 10n * I.accrue(100_000n, "2", 1)); assert.equal(I.accrue(-5_000n, "2", 20), 0n);
  assert.deepEqual([dailyAccrualExact(-5_000n, "2"), dailyAccrualExact(100_000n, "2"), dailyAccrualExact(123_456n, "2")], ["0.00000000", "5.47945205", "6.76471233"]);   // rule 3: max(EOD, 0) × rate / 365, exact to 8 places (cents)
  // Through the daily accrual job on STATE_IOE_ACCRUAL_DAILY: the sweep opens the loan's clock on day 1 and each day's `escrow.interest.accrued` row satisfies the recurring row and re-arms it for the next day — 20 $0 rows while the balance is negative (an advance), then real accrual.
  const clock = new FixedClock("2027-06-02T04:30:00.000Z"); const events = new MemoryEventStore(clock); const engine = new TimerEngine(loadOverriddenRegistry(), events);
  const job = new EscrowInterestAccrualJob(events);
  events.append({ type: "schedule.tick", loanId: "L-1", actor: SYSTEM, payload: { cadence: "daily", at: "00:30", tz: "loan_local", job: "deladv-position-sweep", date: "2027-06-01" } });   // another process's daily tick (15.4) opens no accrual clock
  assert.equal(engine.byCode("STATE_IOE_ACCRUAL_DAILY").length, 0);
  const tick = job.openAccrualClock("L-1", D("2027-06-01"), { state: "NY" }); assert.deepEqual([tick.payload.cadence, tick.payload.job, tick.payload.accrual_clock_on], ["daily", "escrow-interest-accrual", "2027-06-01"]);
  assert.deepEqual(engine.byCode("STATE_IOE_ACCRUAL_DAILY").map((t) => [t.anchorDate, t.dueDate, t.status]), [["2027-06-01", "2027-06-02", "armed"]]);
  for (let d = 0; d < 20; d++) {
    const on = addDays(D("2027-06-01"), d); clock.set(`${addDays(on, 1)}T04:30:00.000Z`);
    const row = job.accrueDay("L-1", { state: "NY", on, eod_balance_cents: -5_000n, rate_pct: "2" });
    assert.deepEqual([row.accrued_cents, row.accrued_exact, row.already_accrued, row.event.payload.accrued_on, row.event.payload.accrual_clock_on], [0n, "0.00000000", false, on, addDays(on, 1)]);
  }
  assert.equal(job.accrueDay("L-1", { state: "NY", on: D("2027-06-05"), eod_balance_cents: -5_000n, rate_pct: "2" }).already_accrued, true);   // a re-run finds the day's row instead of doubling it
  assert.equal(events.ofType("escrow.interest.accrued").length, 20);
  const rows = engine.byCode("STATE_IOE_ACCRUAL_DAILY"); assert.equal(rows.length, 21);
  assert.equal(rows.filter((t) => t.status === "satisfied").length, 20); assert.deepEqual(rows.map((t) => t.anchorDate), Array.from({ length: 21 }, (_, i) => addDays(D("2027-06-01"), i)));
  assert.deepEqual([rows[20]!.status, rows[20]!.dueDate], ["armed", "2027-06-22"]);   // day 21's row is due by the next day's sweep
  const day21 = job.accrueDay("L-1", { state: "NY", on: D("2027-06-21"), eod_balance_cents: 100_000n, rate_pct: "2" }); assert.deepEqual([day21.accrued_cents, day21.accrued_exact], [5n, "5.47945205"]);
  assert.throws(() => job.accrueDay("L-1", { state: "NY", on: D("2027-06-22"), eod_balance_cents: 100_000n, rate_pct: "-1" }), RangeError);
});
test("3.9-T12: Given an OR loan, then the rate changes on Jul 1 and Jan 1 from the May/Nov auction observations minus 100 bps, floored at 0.", () => {
  const obs = { may_pct: "1.75", november_pct: "0.60" };
  assert.deepEqual(orRateFor(D("2027-08-01"), obs), { rate_pct: "0.75", switched_on: "2027-07-01" });
  assert.deepEqual(orRateFor(D("2027-02-01"), obs), { rate_pct: "0", switched_on: "2027-01-01" });
});

// 3.9 worked example (d): a WI loan originated 2016-05-01 at 0.17% on an average $1,500 balance earns $2.55 for 2026.
test("3.9 worked example: WI 0.17% × $1,500 average → $2.55; a 2019 origination earns $0", () => {
  assert.equal(I.accrue(150_000n, I.resolveRate({ state: "WI", origination_date: D("2016-05-01") }), 365), 255n);
  assert.equal(I.exemption({ state: "WI", origination_date: D("2019-03-01") }), "origination_band_none");
});
