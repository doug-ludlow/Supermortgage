/** §16.1–16.4 acceptance tests. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { zonedEpochMs, toIso } from "../../kernel/calendar/zoned.ts";
import { cents } from "../../kernel/money/cents.ts";
import * as Q from "./quote.ts"; import * as M from "./remit.ts"; import * as L from "./release.ts";

const A = { upb_cents: cents("248310.55"), rate_pct: "6.500", lpi_due: D("2026-09-01"), good_through: D("2026-10-15"), late_charges_cents: cents("82.17"), recording_fee_cents: cents("34") };

test("16.1-T1/T2/T3/T4/T6/T7: example A ($1,345.02 / $619.08 / $44.22 / $250,390.82), early/late funds, due-date rules, DSI, example B, MA deadline", () => {
  const q = Q.quote(A); assert.deepEqual([q.interest.months_full, q.interest.days_partial, q.interest.full_cents, q.interest.partial_cents, q.per_diem_cents, q.total_cents], [1, 14, cents("1345.02"), cents("619.08"), cents("44.22"), cents("250390.82")]);
  const early = Q.reconcile(A, q.total_cents, D("2026-10-09"), q.total_cents); assert.equal(early.outcome, "over"); assert.equal(early.variance_cents, cents("265.32"));
  const late = Q.reconcile(A, q.total_cents, D("2026-10-20"), q.total_cents); assert.equal(late.outcome, "short"); assert.equal(late.variance_cents, -cents("221.09"));
  assert.equal(Q.interest(cents("248310.55"), "6.500", D("2026-09-01"), D("2026-10-01")).days_partial, 0); assert.equal(Q.interest(cents("248310.55"), "6.500", D("2026-09-01"), D("2026-10-01")).months_full, 1);
  assert.equal(Q.deemedPayoffDate(D("2026-11-02"), D("2026-11-01")), "2026-11-01"); assert.equal(Q.deemedPayoffDate(D("2026-11-03"), D("2026-11-01")), "2026-11-03");
  const dsi = Q.interest(cents("248310.55"), "6.500", D("2026-09-01"), D("2026-10-15"), "daily_simple_365"); assert.equal(dsi.months_full, 0); assert.equal(dsi.days_partial, 44);
  const b = Q.quote({ upb_cents: cents("180000"), rate_pct: "5.000", lpi_due: D("2026-11-01"), good_through: D("2026-11-20"), nib_deferred_cents: cents("12000") }); assert.deepEqual([b.interest.total_cents, b.per_diem_cents, b.total_cents, b.nib_line_cents], [cents("468.49"), cents("24.66"), cents("192468.49"), cents("12000")]);
  assert.equal(Q.stateStatementDeadline("MA", D("2026-09-14")), "2026-09-21"); assert.equal(Q.stateStatementDeadline("OH", D("2026-09-14")), null);
});

test("16.2-T1/T2/T3/T4/T5/T6/T7/T8: worked example ($1,551.47 collected, $1,489.42 to Fannie Mae, $62.05 fee, $200,989.42), S/S gap $505.58, tolerance, reliance, housekeeping, reversal", () => {
  const ex = Q.quote({ upb_cents: cents("199500"), rate_pct: "6.250", lpi_due: D("2026-09-01"), good_through: D("2026-10-16") }); assert.equal(ex.interest.total_cents, cents("1551.47")); assert.equal(ex.total_cents, cents("201051.47"));
  const share = M.fnmaShare({ type: "AA", upb_cents: cents("199500"), nib_cents: 0n, note_rate_pct: "6.250", ptr_pct: "6.000", lpi_due: D("2026-09-01"), payoff_on: D("2026-10-16") });
  assert.deepEqual([share.interest_cents, share.servicing_fee_cents, share.total_cents], [cents("1489.42"), cents("62.05"), cents("200989.42")]);
  assert.equal(M.fnmaShare({ type: "SS", upb_cents: cents("199500"), nib_cents: 0n, note_rate_pct: "6.250", ptr_pct: "6.000", lpi_due: D("2026-09-01"), payoff_on: D("2026-10-16") }).ss_interest_gap_cents, 50_558n);
  assert.equal(M.fnmaShare({ type: "SS", upb_cents: cents("199500"), nib_cents: 0n, note_rate_pct: "6.250", ptr_pct: "6.000", lpi_due: D("2026-09-01"), payoff_on: D("2026-11-02"), processed_bd1_reported_bd2: true }).interest_cents, 0n);
  assert.equal(M.fnmaShare({ type: "SA", upb_cents: cents("199500"), nib_cents: 0n, note_rate_pct: "6.250", ptr_pct: "6.000", lpi_due: D("2026-09-01"), payoff_on: D("2026-10-16") }).interest_cents, cents("498.75"));
  assert.equal(M.fnmaShare({ type: "AA", upb_cents: cents("180000"), nib_cents: cents("12000"), note_rate_pct: "5", ptr_pct: "4.75", lpi_due: D("2026-11-01"), payoff_on: D("2026-11-20") }).principal_cents, cents("192000"));
  assert.equal(M.variance(cents("100"), cents("130"), false, true).disposition, "paid_in_full_tolerance_expense"); assert.equal(M.variance(cents("100"), cents("321.10"), false, true).disposition, "short_payoff_demand_1bd"); assert.equal(M.variance(cents("100"), cents("321.10"), true, true).disposition, "reliance_absorbed"); assert.equal(M.variance(cents("365.32"), cents("100"), false, true).disposition, "paid_in_full_overage_refund_10bd");
  const clk = M.aaRemittanceClock(zonedEpochMs(D("2026-10-16"), "11:40", "America/New_York")); assert.equal(clk.crs_same_day, true); assert.equal(clk.settlement_on, "2026-10-19"); assert.equal(toIso(clk.lar60_due_ms), toIso(zonedEpochMs(D("2026-10-19"), "20:00", "America/New_York")));
  const hk = M.housekeeping(D("2026-10-16")); assert.equal(hk.escrow_refund_by, "2026-11-16"); assert.equal(hk.short_year_statement_by, "2026-12-15");
  assert.equal(M.reversal(D("2026-10-28"), D("2026-11-03")), "correcting_removal_reopen"); assert.equal(M.reversal(D("2026-11-04"), D("2026-11-03")), "fnma_liquidated_in_error");
});

test("16.3-T1/T2/T3/T4/T5/T6 and 16.4-T1/T2/T3/T5/T6: signatory paths, deadlines (OH 2027-01-14, FL 11-30, CA 30/21, MD 10-23), penalties, deactivation 60 days from recording, gate, eNote", () => {
  assert.equal(L.selectSignatory({ state: "OH", min_active: true, mortgagee_of_record: "mers", lpoa_recorded: false, instrument: "mortgage" }), "mers_signing_officer"); assert.equal(L.selectSignatory({ state: "TX", min_active: false, mortgagee_of_record: "fnma", lpoa_recorded: false, instrument: "deed_of_trust" }), "send_to_fnma_documents"); assert.equal(L.selectSignatory({ state: "CA", min_active: true, mortgagee_of_record: "mers", lpoa_recorded: true, instrument: "deed_of_trust", third_party_trustee: true }), "trustee_reconveyance"); assert.equal(L.selectSignatory({ state: "CO", min_active: true, mortgagee_of_record: "mers", lpoa_recorded: true, instrument: "deed_of_trust" }), "public_trustee"); assert.equal(L.selectSignatory({ state: "NY", min_active: false, mortgagee_of_record: "prior_lender", lpoa_recorded: false, instrument: "mortgage" }), "obtain_assignment_first");
  assert.equal(L.releaseDeadline("OH", D("2026-10-16")).due_on, "2027-01-14"); assert.equal(L.releaseDeadline("FL", D("2026-10-16")).due_on, "2026-11-30"); assert.equal(L.releaseDeadline("MD", D("2026-10-16")).due_on, "2026-10-23");
  assert.deepEqual(L.caTrusteeClocks(D("2026-10-16"), D("2026-10-28")), { deliver_by: "2026-11-15", trustee_record_by: "2026-11-18" });
  const t = L.internalTimers(D("2026-10-16")); assert.deepEqual([t.prepare_by, t.execute_by, t.submit_by, t.custody_request_by], ["2026-10-23", "2026-10-28", "2026-11-06", "2026-10-19"]);
  assert.equal(L.penaltyExposure("NY", 61), 100_000n); assert.equal(L.penaltyExposure("NY", 91), 150_000n); assert.equal(L.penaltyExposure("OH", 0), 0n); assert.equal(L.penaltyExposure("CT", 100), 300_000n);
  assert.equal(L.feePassThrough({ state: "CA", c1205_conditions: true, allowed: true, disclosed_on_statement: true, fee_cents: 4_500n }).chargeable, true); assert.equal(L.feePassThrough({ state: "CA", c1205_conditions: true, allowed: true, disclosed_on_statement: true, fee_cents: 4_600n }).chargeable, false);
  assert.equal(L.deactivationGate(false).ok, false); const dc = L.deactivationClocks(D("2026-10-26")); assert.deepEqual([dc.due_on, dc.policy_target, dc.verify_by], ["2026-12-25", "2026-11-02", "2026-10-29"]); assert.equal(L.deactivationClocks(D("2026-11-10")).due_on, "2027-01-09");
  assert.deepEqual(L.enoteClocks(D("2026-10-16"), D("2026-10-26")), { paid_off_status_by: "2026-10-20", paper_copy_by: "2026-11-09" }); assert.equal(L.reversalDue(D("2026-10-28")), "2026-11-04");
  assert.equal(L.mreException({ min_active: true, paid_off_release_recorded_on: D("2026-08-15"), today: D("2026-11-30"), loan_active: false, subservicer_is_us: true }), "active_min_on_paid_loan");
});
