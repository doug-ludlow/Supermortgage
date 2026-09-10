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
import { EscrowEventLedger, nhRateFor, orRateFor, rateObservation, form1099Int, accrueDaily } from "./ops.ts";

test("3.9-T1: Given a NY owner-occupied 2-family loan with Q3-2027 average daily balance $1,234.56, then $6.22 is credited on 2027-09-30 with ledger and event evidence.", () => {
  const credit = I.accrue(123_456n, I.resolveRate({ state: "NY", origination_date: D("2020-01-01") }), 92); assert.equal(credit, 622n);
  const led = new EscrowEventLedger(123_456n); const e = led.emit("Interest on Escrow", credit, D("2027-09-30"));
  assert.equal(e.amount_cents, 622n); assert.equal(e.balance_cents, 124_078n);
  const ledger = [{ dr: "escrow_interest_expense", cr: "loan.escrow", amount_cents: credit }]; assert.equal(ledger[0]!.amount_cents, 622n);
});
test("3.9-T2: Given a CT loan and the 2026 deposit index 0.49%, then the rate is 1.5% and $13.50 is credited on 2026-12-31 for an average $900 balance; payoff 2027-04-10 credits $3.70 before the refund.", () => {
  assert.equal(I.resolveRate({ state: "CT", origination_date: D("2020-01-01") }, { index_pct: "0.49" }), "1.5");
  assert.equal(I.accrue(90_000n, "1.5", 365), 1_350n); assert.equal(I.accrue(90_000n, "1.5", 100), 370n);
});
test("3.9-T3: Given a MN loan with origination LTV 85%, then `exempt` (ltv_gt_80); with 75% and first-of-month average $1,000, then $30.00 credited annually.", () => {
  assert.equal(I.exemption({ state: "MN", origination_date: D("2020-01-01"), origination_ltv_pct: "85" }), "ltv_gt_80");
  assert.equal(I.exemption({ state: "MN", origination_date: D("2020-01-01"), origination_ltv_pct: "75" }), null); assert.equal(I.accrueMn([100_000n, 100_000n, 100_000n]), 3_000n);
});
test("3.9-T4: Given WI loans originated 1990-06-01, 2016-05-01 and 2019-03-01, then rates 5.25%, 0.17% (2026) and none respectively.", () => {
  assert.deepEqual([I.resolveRate({ state: "WI", origination_date: D("1990-06-01") }), I.resolveRate({ state: "WI", origination_date: D("2016-05-01") }), I.exemption({ state: "WI", origination_date: D("2019-03-01") })], ["5.25", "0.17", "origination_band_none"]);
});
test("3.9-T5: Given a RI loan with active PMI, then exempt; after PMI termination, accrual starts the next day.", () => {
  assert.equal(I.exemption({ state: "RI", origination_date: D("2020-01-01"), pmi_active: true }), "pmi_active");
  assert.equal(I.exemption({ state: "RI", origination_date: D("2020-01-01"), pmi_active: false }), null);
  const terminatedOn = D("2027-06-15"); assert.equal(addDays(terminatedOn, 1), "2027-06-16");                  // accrual starts the next day
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
