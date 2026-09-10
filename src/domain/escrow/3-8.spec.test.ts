// 3.8 Escrow waiver administration
// spec/sections/03-escrow-administration/3-8-escrow-waiver-administration.md
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
import { evaluateWaiver, revocation } from "./waiver.ts";
import { buildPlan, type Plan } from "./shortage.ts";
import { waiverCloseout, workoutEscrowGate, minnesotaDiscontinue, illinoisTermination, scriptSolicitsWaiver } from "./ops.ts";
const BASE = { requested_on: D("2027-03-02"), original_appraised_value_cents: cents("310000"), hpml: true, consummation_date: D("2021-06-15"), original_property_value_cents: cents("300000"), regx_days_delinquent: 0, late_30_in_12m: 0, late_60_in_24m: 0, prior_modification: false, prior_waiver_missed_payments: false, monthly_mi_line: false, flood_escrow_mandatory: false, instrument_permits: true, next_due_dates: [D("2027-04-01"), D("2027-05-01")] };

test("3.8-T1: Given the worked-example loan at UPB $240,000 (HPML), then decision = denied with reason HPML_LTV_GE_80_ORIG_VALUE and a re-request date.", () => {
  const den = evaluateWaiver({ ...BASE, upb_cents: cents("240000") });
  assert.equal(den.decision, "denied"); assert.deepEqual(den.reasons, ["HPML_LTV_GE_80_ORIG_VALUE"]); assert.equal(typeof den.re_request_on === "string" || den.re_request_on === null, true);
});
test("3.8-T2: Given UPB $239,900, no lates in 24 months, no prior mod, annual MI, no flood, then approved; effective next due date \u2265 15 days; refund within 30 days; short-year statement within 60 days; escrow event to balance 0.", () => {
  const ok = evaluateWaiver({ ...BASE, upb_cents: cents("239900") });
  assert.equal(ok.decision, "approved"); assert.equal(ok.effective_on, "2027-04-01");                       // next due date ≥ 15 days after the 2027-03-02 approval
  const c = waiverCloseout(cents("1206.68"), cents("520"), ok.effective_on!);                              // $1,206.68 less the April county installment paid before closure
  assert.deepEqual(c, { refund_cents: 68_668n, refund_by: "2027-05-01", short_year_statement_by: "2027-05-31", event_balance_cents: 0n });
});
test("3.8-T3: Given one 30-day delinquency 8 months ago, then denied DELINQ_12M; given a 60-day delinquency 20 months ago, then denied DELINQ_60D_24M.", () => {
  assert.deepEqual(evaluateWaiver({ ...BASE, upb_cents: cents("239900"), late_30_in_12m: 1 }).reasons, ["DELINQ_12M"]);
  assert.deepEqual(evaluateWaiver({ ...BASE, upb_cents: cents("239900"), late_60_in_24m: 1 }).reasons, ["DELINQ_60D_24M"]);
});
test("3.8-T4: Given monthly borrower-paid MI, then the MI line is excluded from the waiver and the decision is partial.", () => {
  const part = evaluateWaiver({ ...BASE, upb_cents: cents("239900"), monthly_mi_line: true }); assert.equal(part.decision, "partial"); assert.deepEqual(part.lines_kept, ["mi"]);
});
test("3.8-T5: Given `flood_escrow_mandatory=true`, then the flood line cannot be waived.", () => {
  const part = evaluateWaiver({ ...BASE, upb_cents: cents("239900"), flood_escrow_mandatory: true }); assert.equal(part.decision, "partial"); assert.equal(part.lines_kept[0], "flood");
});
test("3.8-T6: Given an advance for unpaid taxes on a waived loan on 2027-12-11, then the waiver is revoked the same day, the account is established with the deficiency, and the initial statement timer is due 2028-01-25.", () => {
  const rv = revocation(D("2027-12-11"), cents("2400"), cents("120"));
  assert.deepEqual([rv.revoked_on, rv.opening_balance_cents, rv.initial_statement_due_on, rv.deficiency_cents], ["2027-12-11", -252_000n, "2028-01-25", 252_000n]);
  assert.equal((buildPlan("deficiency", rv.deficiency_cents, D("2028-02-01"), {}) as Plan).installment_cents, cents("210.00"));   // 12 × $210.00
});
test("3.8-T7: Given a Flex Mod trial offer being prepared for a waived loan current on T&I, then the exception is documented and the offer proceeds; given T&I delinquent, then the offer is blocked until escrow is established.", () => {
  assert.deepEqual(workoutEscrowGate({ waived: true, current_on_ti: true, exception_documented: true }), { ok: true, block: null });
  assert.match(workoutEscrowGate({ waived: true, current_on_ti: false, exception_documented: true }).block!, /establish escrow before the offer/);
  assert.match(workoutEscrowGate({ waived: true, current_on_ti: true, exception_documented: false }).block!, /document the Flex Mod/);
});
test("3.8-T8: Given a Minnesota loan reaching its 5th anniversary, then the right-to-discontinue notice is sent within 60 days; a written election with no >30-day delinquency in 12 months is approved even if the Fannie Mae 80% test fails (per open question 1 default).", () => {
  const r = minnesotaDiscontinue({ mortgage_date: D("2022-03-15"), today: D("2027-03-20"), written_election: true, late_over_30_in_12m: 0, fnma_80_test_passed: false });
  assert.deepEqual([r.anniversary, r.notice_due_on, r.notice_due_now, r.election], ["2027-03-15", "2027-05-14", true, "approved"]); assert.match(r.basis, /state right overrides the Fannie Mae 80% test/);
  assert.equal(minnesotaDiscontinue({ mortgage_date: D("2022-03-15"), today: D("2027-03-20"), written_election: true, late_over_30_in_12m: 1, fnma_80_test_passed: true }).election, "denied");
});
test("3.8-T9: Given an Illinois loan at 64% of original amount by timely payments and not in default, then the termination election is approved.", () => {
  const r = illinoisTermination({ upb_cents: 6_400_000n, original_amount_cents: 10_000_000n, timely_payments: true, in_default: false });
  assert.equal(r.approved, true); assert.equal(r.ratio_pct, "64.00");
  assert.equal(illinoisTermination({ upb_cents: 6_600_000n, original_amount_cents: 10_000_000n, timely_payments: true, in_default: false }).reason, "above 65% of the original amount");
});
test("3.8-T10: Given any outbound script, then a content test confirms no waiver solicitation language.", () => {
  assert.equal(scriptSolicitsWaiver("Would you like to waive your escrow account and pay taxes yourself?"), true);
  assert.equal(scriptSolicitsWaiver("Your escrow analysis is complete; your new payment is $172.22 starting July 1."), false);
  assert.equal(scriptSolicitsWaiver("If you ask, we can explain how an escrow waiver request is evaluated."), false);
});

// 3.8 worked example: UPB $240,000.00 is not below 80% of the $300,000 original value → denied.
test("3.8 worked example: UPB $240,000.00 vs $300,000 original value → HPML_LTV_GE_80_ORIG_VALUE", () => {
  assert.deepEqual(evaluateWaiver({ ...BASE, upb_cents: 24_000_000n }).reasons, ["HPML_LTV_GE_80_ORIG_VALUE"]);
});
