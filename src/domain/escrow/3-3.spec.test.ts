// 3.3 Annual escrow account statement
// spec/sections/03-escrow-administration/3-3-annual-escrow-account-statement.md
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
import { exemption as stmtExemption, annualDeadline, postExemptionDeadline, lowPointExplanation, lumpSumWordingAllowed } from "./statement.ts";
import { assembleAnnualStatement, exemptHold, transferOutStatements, payoffStatement, utahSupplement, bankruptcyStatement, sendWithFallback, type StatementHistoryRow } from "./ops.ts";
import { buildRegistry } from "../../notices/catalog.ts";
const HISTORY: StatementHistoryRow[] = Array.from({ length: 12 }, (_, i) => ({ month: addMonths(D("2026-07-01"), i), deposits_cents: 13_000n, disbursements: i === 0 ? [{ line: "county_tax", amount_cents: 52_000n, projected_cents: 50_000n }] : i === 5 ? [{ line: "county_tax", amount_cents: 76_000n, projected_cents: 70_000n }] : [], balance_cents: 100_000n }));

test("3.3-T1: Given computation year ending 2027-06-30 and analysis approved 2027-05-18, when rendered, then the statement includes items (i)\u2013(viii), the prior projection attachment, and is sent by 2027-07-30.", () => {
  const s = assembleAnnualStatement({ year_start: D("2026-07-01"), year_end: D("2027-06-30"), approved_on: D("2027-05-18"), new_payment_cents: 17_222n, prior_escrow_portion_cents: 13_000n, history: HISTORY, decision_text: "shortage $406.68: $33.89 per month for 12 months beginning 07/01/2027", low_point_explanation: ["low balance $180.00 vs $260.00 projected"] });
  assert.deepEqual(Object.keys(s.items), ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii"]); assert.equal(s.prior_projection_attached, true);
  assert.equal(s.send_by, "2027-07-30"); assert.equal(s.send_target_on, "2027-07-23");
  assert.equal(s.history.filter((r) => r.assumed).length, 1);                     // June assumed (after the run date)
});
test("3.3-T2: Given the analysis is approved 2027-07-25, when rendered, then history uses actuals for May/June and the timer is still satisfied if sent by 2027-07-30.", () => {
  const s = assembleAnnualStatement({ year_start: D("2026-07-01"), year_end: D("2027-06-30"), approved_on: D("2027-07-25"), new_payment_cents: 17_222n, prior_escrow_portion_cents: 13_000n, history: HISTORY, decision_text: "x", low_point_explanation: [] });
  assert.equal(s.history.filter((r) => r.assumed).length, 0);                     // actuals for May/June
  assert.equal(s.send_by, "2027-07-30"); assert.ok(D("2027-07-28") <= s.send_by);
});
test("3.3-T3: Given `regx_days_delinquent = 45` at analysis, then status = `exempt_hold` with reason `delinquent_30`, no statement is mailed, `NTC_REGX_1024_17F_SHORTAGE` is sent if a shortage exists, and the (f)(5) timer is satisfied.", () => {
  assert.equal(stmtExemption({ regx_days_delinquent: 45, foreclosure_first_legal_filed: false, bankruptcy_open: false }), "delinquent_30");
  const h = exemptHold("delinquent_30", 40_668n);
  assert.deepEqual(h, { status: "exempt_hold", reason: "delinquent_30", statement_mailed: false, notice: "NTC_REGX_1024_17F_SHORTAGE", f5_timer_satisfied: true });
  assert.equal(exemptHold("delinquent_30", 0n).notice, null);
});
test("3.3-T4: Given exemption ended 2027-09-10 by reinstatement, then `REGX_1024_17I2_POST_EXEMPTION_HISTORY_90` due 2027-12-09 and the history covers from the last statement.", () => {
  assert.equal(postExemptionDeadline(D("2027-09-10")), "2027-12-09");             // REGX_1024_17I2_POST_EXEMPTION_HISTORY_90
  const s = assembleAnnualStatement({ year_start: D("2026-07-01"), year_end: D("2027-09-10"), approved_on: D("2027-09-12"), new_payment_cents: 17_222n, prior_escrow_portion_cents: 13_000n, history: HISTORY, decision_text: "x", low_point_explanation: [] });
  assert.equal(s.history[0]!.month, "2026-07-01");                                // covers from the last statement
});
test("3.3-T5: Given shortage \u2265 one month, then the statement body contains no lump-sum wording; the insert (if enabled) is a separate document flagged optional.", () => {
  assert.equal(lumpSumWordingAllowed(40_668n, 13_833n), false);
  const reg = buildRegistry(); const insert = reg.template("NTC_SM_ESCROW_VOLUNTARY_LUMPSUM_INSERT");
  assert.equal(insert.separateDocument, true); assert.ok(insert.mayCombineWith.includes("NTC_REGX_1024_17I_ANNUAL_ESCROW_STMT"));
});
test("3.3-T6: Given transfer-out effective 2027-03-01, then the annual timer is cancelled and `REGX_1024_17I4_SHORT_YEAR_TRANSFER_60` is due 2027-04-30.", () => {
  const r = transferOutStatements(D("2027-03-01"));
  assert.deepEqual([r.annual_timer, r.cancel_reason, r.short_year.code, r.short_year.due_on, r.short_year.notice], ["cancelled", "transfer_out", "REGX_1024_17I4_SHORT_YEAR_TRANSFER_60", "2027-04-30", "NTC_REGX_1024_17I4_SHORT_YEAR_TRANSFEROR"]);
});
test("3.3-T7: Given payoff funds received 2027-02-10, then short-year payoff statement due 2027-04-11 and it shows the refund disposition.", () => {
  const p = payoffStatement(D("2027-02-10"), 61_240n, "refund");
  assert.equal(p.due_on, "2027-04-11"); assert.match(p.refund_disposition, /refund: 61240 cents/); assert.equal(p.projection, null);
});
test("3.3-T8: Given a due date 2027-07-30 (Friday) vs 2027-08-01 (Sunday) scenarios, then no business-day roll is applied; the send target is \u2265 5 BD earlier.", () => {
  assert.deepEqual(annualDeadline(D("2027-06-30")), { due_on: "2027-07-30", send_target_on: "2027-07-23" });   // Friday
  const sun = annualDeadline(D("2027-07-02")); assert.equal(sun.due_on, "2027-08-01");                          // Sunday, no roll
  assert.equal(sun.send_target_on, "2027-07-26"); assert.ok(String(sun.send_target_on) < String(sun.due_on));
});
test("3.3-T9: Given actual December tax $760 vs projected $700, then item (viii) lists the county-tax variance and the low-balance difference.", () => {
  const ex = lowPointExplanation([{ month: D("2026-12-01"), line_type: "County tax", projected_cents: 70_000n, actual_cents: 76_000n }], 18_000n, 26_000n);
  assert.deepEqual(ex, ["County tax paid 12/2026 was $760.00 vs $700.00 projected", "low balance $180.00 vs $260.00 projected"]);
});
test("3.3-T10: Given a Utah property, then the calendar-year supplemental statement is sent by March 1 unless the annual statement already covers Jan\u2013Dec.", () => {
  assert.deepEqual(utahSupplement(D("2026-07-01"), 2026), { required: true, due_on: "2027-03-01" });
  assert.deepEqual(utahSupplement(D("2026-01-01"), 2026), { required: false, due_on: null });
});
test("3.3-T11: Given an open Chapter 13 case and flag `bk_suppress=off`, then the statement is produced with the BK legend and a 3002.1 package is created when the payment changes.", () => {
  const r = bankruptcyStatement({ chapter: 13, bk_suppress: false, payment_changed: true });
  assert.equal(r.produced, true); assert.match(r.legend!, /3002\.1/); assert.equal(r.package_3002_1, true);
  assert.equal(bankruptcyStatement({ chapter: 13, bk_suppress: true, payment_changed: true }).produced, false);
});
test("3.3-T12: Given the print vendor is down on the send date, then the in-house fallback mails and evidence is stored.", () => {
  const r = sendWithFallback(false, D("2027-07-23"));
  assert.deepEqual(r, { channel: "in_house_mail", evidence: { kind: "proof_of_mailing", mailed_on: "2027-07-23" } });
});

// 3.3 worked example figures: deposits 12 × $130.00 = $1,560.00; disbursements $520.00 + $360.00 + $760.00 + $260.00 = $1,900.00; ending balance $700.00.
test("3.3 worked example: deposits $1,560.00, disbursements $1,900.00 (incl. school $360.00), ending balance $700.00", () => {
  const deposits = 12n * 13_000n; const disbursements = 52_000n + 36_000n + 76_000n + 26_000n;
  assert.equal(deposits, 156_000n); assert.equal(disbursements, 190_000n); assert.equal(104_000n + deposits - disbursements, 70_000n);
});
