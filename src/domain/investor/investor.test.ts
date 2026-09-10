/** §5.1–5.7 acceptance tests. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { zonedEpochMs, toIso } from "../../kernel/calendar/zoned.ts";
import { assignActivityPeriod, larDeadlineMs, lar83DeadlineMs, iredSweepDate, calendarDraftDate, fundingGateMs, eventDeadlineMs, fannieBusinessDay } from "./period.ts";
import { zoned, unzoned, projectLar96, idempotencyKey, prevalidate } from "./lar.ts";
import { scheduledMonth, scheduleForward, saInterest, aaRemittance, payoffInterest, crsAaRequest, specialRemittanceDeadline, classifyVariance, compensatoryFee, gfeeCheckFigure, fundingDecision } from "./remittance.ts";
import { actionCode, removalAmounts } from "./liquidation.ts";
import { predictSda, advanceSchedule, applyRecovery, consecutiveMonthsDelinquent, gfeeSchedule } from "./sda.ts";
import { mbsRepurchasePrice, portfolioAaRepurchasePrice, appealLadder, dpoIndemnification } from "./repurchase.ts";
import { statusLine, deriveStatusCode, consistencyErrors, trialCompletionDate, inPopulation, type LoanStatusFacts } from "./delinquency-status.ts";
import { cents } from "../../kernel/money/cents.ts";

const ET = "America/New_York";
const at = (d: string, hhmm: string) => zonedEpochMs(D(d), hhmm, ET);

test("5.1-T8: zoned overpunch encoding and 80-byte LAR 96 record", () => {
  assert.equal(zoned(-991n), "0000000099J");
  assert.equal(zoned(80_002n), "0000008000B");
  assert.equal(zoned(125_000n), "0000012500{");
  assert.equal(unzoned("0000000099J"), -991n); assert.equal(unzoned("0000008000B"), 80_002n);
  const lar = projectLar96("123456789", "4000000001", { lpi_date: D("2026-10-01"), upb_cents: 24_977_400n, nib_cents: 0n, interest_cents: 125_000n, principal_cents: 22_600n, other_fees_cents: 0n, action_code: "00", action_date: D("2026-10-13") });
  assert.equal(lar.record.length, 81); assert.ok(lar.record.endsWith("\r"));
  assert.deepEqual([lar.fields.interest, lar.fields.principal, lar.fields.upb, lar.fields.lpi, lar.fields.action_date], ["0000012500{", "0000002260{", "0002497740{", "1026", "101326"]);
});

test("5.1-T1/T3/T9/T2: S/S worked example and the reporting calendar", () => {
  const m = scheduledMonth(cents("250000"), "6.500", "6.000", cents("1580.17"));
  assert.deepEqual([m.gross_interest_cents, m.scheduled_principal_cents, m.ending_scheduled_upb_cents, m.fnma_interest_cents, m.servicing_fee_cents], [135_417n, 22_600n, 24_977_400n, 125_000n, 10_417n]);
  // processed Tue 2026-10-13 15:10 ET → due Wed 2026-10-14 20:00 ET
  assert.equal(toIso(larDeadlineMs(at("2026-10-13", "15:10"), false)), toIso(at("2026-10-14", "20:00")));
  // removal processed Mon Nov 2 (BD1) → Tue Nov 3 17:00 ET; processed Fri Oct 30 → Mon Nov 2 20:00 ET
  assert.equal(fannieBusinessDay(D("2026-11-02"), 1), "2026-11-02");
  assert.equal(toIso(larDeadlineMs(at("2026-11-02", "10:00"), true)), toIso(at("2026-11-03", "17:00")));
  assert.equal(toIso(larDeadlineMs(at("2026-10-30", "10:00"), true)), toIso(at("2026-11-02", "20:00")));
  assert.equal(toIso(lar83DeadlineMs(D("2026-10-01"))), toIso(at("2026-10-08", "20:00")));
  assert.equal(iredSweepDate(D("2026-10-01")), "2026-10-22"); assert.equal(iredSweepDate(D("2026-11-01")), "2026-11-20");
  assert.equal(toIso(eventDeadlineMs(at("2026-11-23", "15:00"))), toIso(at("2026-11-24", "03:00")));
});

test("5.1 rule 2: activity period assignment around BD2 17:00 ET", () => {
  const open = ["2026-09", "2026-10"];
  assert.equal(assignActivityPeriod(D("2026-09-28"), at("2026-10-02", "10:00"), false, open), "2026-09");    // prior-month effective before BD2 → earliest open
  assert.equal(assignActivityPeriod(D("2026-10-01"), at("2026-10-02", "10:00"), false, open), "2026-10");
  assert.equal(assignActivityPeriod(D("2026-10-01"), at("2026-10-02", "10:00"), true, open), "2026-09");     // current-month removal by BD2 → earliest open
  assert.equal(assignActivityPeriod(D("2026-09-28"), at("2026-10-02", "17:01"), false, open), "2026-10");    // after BD2 17:00 → current
});

test("5.1-T10: sequence order and idempotency key; pre-validation catches UPB drift and LPI", () => {
  const p = { lpi_date: D("2026-10-01"), upb_cents: 24_977_400n, nib_cents: 0n, interest_cents: 125_000n, principal_cents: 22_600n, other_fees_cents: 0n, action_code: "00", action_date: D("2026-10-13") };
  assert.equal(idempotencyKey("1", "L", "payment.contractual", D("2026-10-13"), 1, p), idempotencyKey("1", "L", "payment.contractual", D("2026-10-13"), 1, p));
  assert.notEqual(idempotencyKey("1", "L", "payment.contractual", D("2026-10-13"), 1, p), idempotencyKey("1", "L", "payment.contractual", D("2026-10-13"), 2, p));
  assert.deepEqual(prevalidate(p, { upb_cents: 24_977_400n, lpi_date: D("2026-09-01") }, D("2026-10-14"), D("2026-09-13")), []);
  assert.equal(prevalidate(p, { upb_cents: 24_977_410n, lpi_date: D("2026-09-01") }, D("2026-10-14"), null).length, 1);
  assert.equal(prevalidate(p, { upb_cents: 24_977_400n, lpi_date: D("2026-10-01") }, D("2026-10-14"), null).length, 1);
});

test("5.2-T1/T2: S/S schedule 1,476.00/1,476.10/1,476.19/1,476.29 with Nov 18 draft and Nov 17 16:00 gate; S/A month-4 recovery −2,992.50 with Dec 18 draft", () => {
  const s = scheduleForward(cents("250000"), "6.500", "6.000", cents("1580.17"), 4);
  assert.deepEqual(s.map((m) => m.fnma_interest_cents + m.fnma_principal_cents), [147_600n, 147_610n, 147_619n, 147_629n]);
  assert.equal(s.reduce((a, m) => a + m.fnma_interest_cents + m.fnma_principal_cents, 0n), 590_458n);
  assert.equal(calendarDraftDate(D("2026-11-01"), 18), "2026-11-18");
  assert.equal(toIso(fundingGateMs(D("2026-11-18"))), toIso(at("2026-11-17", "16:00")));
  assert.equal(saInterest(cents("199500"), "6.000", 1), 99_750n); assert.equal(saInterest(cents("199500"), "6.000", 4), -299_250n);
  assert.equal(calendarDraftDate(D("2026-12-01"), 20), "2026-12-18");
});

test("5.2-T3/T4/T5: A/A CRS 001 threshold and Veterans Day settlement; A/A remittance 2,544.38", () => {
  const r = crsAaRequest(cents("2600"), D("2026-11-10"), false);
  assert.equal(r.instruct, true); assert.equal(r.settlement_date, "2026-11-12");
  assert.equal(crsAaRequest(cents("900"), D("2026-11-30"), true).instruct, true);
  assert.equal(crsAaRequest(cents("900"), D("2026-11-10"), false).instruct, false);
  const aa = aaRemittance(cents("400000"), "6.875", "6.625", 33_605n);
  assert.deepEqual([aa.note_interest_cents, aa.fnma_interest_cents, aa.servicing_fee_cents, aa.remittance_cents], [229_167n, 220_833n, 8_334n, 254_438n]);
});

test("5.2-T6/T7/T9/T10/T11/T12: payoff interest by type; variance classes; comp fee; surplus 90 days; short-sale CRS deadline", () => {
  assert.equal(payoffInterest("AA", cents("199500"), "6.000", D("2026-09-01"), D("2026-10-16")), 148_942n);
  assert.equal(payoffInterest("SA", cents("199500"), "6.000", D("2026-09-01"), D("2026-10-16")), 49_875n);
  assert.equal(payoffInterest("SS", cents("199500"), "6.000", D("2026-09-01"), D("2026-10-16")), 99_750n);
  const v = classifyVariance(147_639n, 0n, { sda_credit_cents: -147_639n }); assert.equal(v.class, "sda_credit"); assert.equal(v.draft_expectation_cents, 0n);
  assert.equal(classifyVariance(5_231_011n, 5_231_011n, {}).class, "fnma_projection"); assert.equal(classifyVariance(5_231_011n, 5_231_012n, {}).class, "unexplained");
  assert.equal(compensatoryFee(cents("50000"), 3, "7.50"), 25_000n);
  assert.equal(compensatoryFee(cents("5000000"), 30, "7.50"), 4_315_068n);
  assert.equal(specialRemittanceDeadline(D("2026-10-08")), "2026-10-13");
  assert.deepEqual(fundingDecision(cents("10000"), cents("7000")), { shortfall_cents: 300_000n, advance: true, dual_control: false });
  assert.equal(fundingDecision(cents("300000"), 0n).dual_control, true);
});

test("5.3-T1/T3/T4/T5: liquidation codes and amounts", () => {
  assert.equal(actionCode("payoff", "none"), "60"); assert.equal(actionCode("foreclosure_fnma_acquires", "mi"), "72"); assert.equal(actionCode("foreclosure_fnma_acquires", "none"), "70"); assert.equal(actionCode("third_party_sale", "none"), "71");
  const tp = removalAmounts({ kind: "third_party_sale", insured: "none", type: "SS", actual_upb_cents: 0n, scheduled_upb_cents: cents("249088.61"), nib_cents: 0n, ptr: "6.000", legal_date: D("2026-10-14"), period_open: true });
  assert.deepEqual([tp.action_code, tp.principal_cents, tp.interest_cents, tp.reported_late], ["71", 24_908_861n, 124_544n, false]);
  const po = removalAmounts({ kind: "payoff", insured: "none", type: "AA", actual_upb_cents: cents("199500"), scheduled_upb_cents: 0n, nib_cents: 0n, ptr: "6.000", legal_date: D("2026-10-16"), period_open: true, interest_cents: payoffInterest("AA", cents("199500"), "6.000", D("2026-09-01"), D("2026-10-16")) });
  assert.deepEqual([po.action_code, po.interest_cents], ["60", 148_942n]);
  assert.equal(removalAmounts({ kind: "payoff", insured: "none", type: "AA", actual_upb_cents: cents("180000"), scheduled_upb_cents: 0n, nib_cents: cents("12000"), ptr: "6.000", legal_date: D("2026-10-16"), period_open: true, interest_cents: 0n }).principal_cents, cents("192000"));
});

test("5.4-T1/T2/T3 and 5.5: SDA prediction, four advances $5,904.58 with rolled draft dates, recovery order, g-fee figures", () => {
  assert.equal(consecutiveMonthsDelinquent(D("2026-11-01"), D("2027-03-31")), 4);
  const st = predictSda(D("2026-11-01"), "SS", "special", D("2027-03-31"));
  assert.equal(st.status, "predicted"); assert.equal(st.predicted_entry_period, "2027-03");
  assert.equal(predictSda(D("2026-11-01"), "SS", "regular", D("2027-03-31")).status, "not_applicable");
  const adv = advanceSchedule(D("2026-11-01"), cents("250000"), "6.500", "6.000", cents("1580.17"));
  assert.equal(adv.total_cents, 590_458n);
  assert.deepEqual(adv.drafts.map((d) => d.draft_date), ["2027-01-15", "2027-02-18", "2027-03-18", "2027-04-16"]);
  const s: typeof st = { ...st, status: "active", fm_pi_receivable_cents: 295_286n, servicer_advances_outstanding_cents: 590_458n, advances: adv.drafts.map((d) => ({ period: d.period, amount_cents: d.amount_cents, draft_date: d.draft_date, status: "outstanding" as const })) };
  const r = applyRecovery(s, 295_286n); assert.deepEqual([r.to_fnma_receivable_cents, r.to_servicer_advances_cents, s.fm_pi_receivable_cents], [295_286n, 0n, 0n]);
  const r2 = applyRecovery(s, 147_600n); assert.equal(r2.to_servicer_advances_cents, 147_600n); assert.equal(s.advances[0]!.status, "recovered_from_borrower");   // F-1-20: the servicer retains the borrower's payment; `reimbursed_by_fnma` is the reclass/deferral/liquidation exit
  assert.deepEqual(gfeeSchedule(cents("250000"), "6.500", "6.000", cents("1580.17"), "0.250", 4), [5_208n, 5_204n, 5_199n, 5_194n]);
  assert.equal(gfeeCheckFigure(cents("250000"), "0.250"), 5_208n);
});

test("5.6-T1/T2/T3/T6: repurchase ladder, MBS and portfolio pricing, DPO indemnification", () => {
  assert.deepEqual(appealLadder(D("2026-09-15"), D("2026-12-01")), { pay_by: "2026-11-14", first_appeal_by: "2026-11-14", second_appeal_by: "2026-12-16" });
  assert.deepEqual(mbsRepurchasePrice(cents("199500"), "6.000"), { principal_cents: 19_950_000n, interest_cents: 99_750n, price_cents: 20_049_750n, action_code: "65" });
  const p = portfolioAaRepurchasePrice(cents("199500"), "101.500", "6.000", D("2026-09-01"), D("2026-10-16"));
  assert.deepEqual([p.principal_cents, p.interest_cents, p.price_cents], [20_249_250n, 148_942n, 20_398_192n]);
  assert.equal(dpoIndemnification(cents("30000"), "60"), 1_800_000n); assert.equal(dpoIndemnification(cents("30000"), "70", 1_800_000n), 300_000n);
});

test("5.7-T1/T2/T3/T4/T7: status code derivation", () => {
  const nov: LoanStatusFacts = { fnma_delinquency_status: "60", lpi: D("2026-08-01"), actions: [{ kind: "qrpc_no_solution", at: "2026-10-20T15:00:00Z" }], hardship: "unemployment", contact_achieved: true };
  assert.deepEqual(statusLine(nov), { status: "AW", reason: "016", effective: "20261020", completion: "        " });
  const dec: LoanStatusFacts = { ...nov, fnma_delinquency_status: "90", actions: [{ kind: "qrpc_no_solution", at: "2026-10-20T15:00:00Z", already_reported: true }, { kind: "brp_complete", at: "2026-11-18T12:00:00Z" }, { kind: "trial_active", at: "2026-12-01T12:00:00Z", effective: D("2027-01-01"), completion: trialCompletionDate(D("2027-01-01"), 3) }] };
  assert.deepEqual(statusLine(dec), { status: "BF", reason: "016", effective: "20270101", completion: "20270331" });
  const fb: LoanStatusFacts = { fnma_delinquency_status: "current", lpi: D("2026-11-01"), actions: [{ kind: "forbearance_active", at: "2026-11-10T12:00:00Z", effective: D("2026-12-01"), completion: D("2027-02-28") }], hardship: "other", contact_achieved: true };
  assert.equal(inPopulation(fb), true);
  const l = statusLine(fb, { imminent_default: true, forbearance_payment_cents: 0n, forbearance_payment_received_on: null })!;
  assert.deepEqual([l.status, l.effective, l.completion, l.forbearance!.pos47, l.forbearance!.pos49, l.forbearance!.pos51_61, l.forbearance!.pos63_70], ["09", "20261201", "20270228", "0", "1", "00000000.00", "        "]);
  const bk: LoanStatusFacts = { fnma_delinquency_status: "120+", lpi: D("2026-05-01"), actions: [{ kind: "sale_scheduled", at: "2026-10-01T12:00:00Z", effective: D("2026-11-05") }, { kind: "bankruptcy", at: "2026-10-28T12:00:00Z", chapter: "13" }], hardship: null, contact_achieved: false };
  assert.equal(deriveStatusCode(bk)!.code, "67"); assert.equal(statusLine(bk)!.reason, "031");
  const ref: LoanStatusFacts = { fnma_delinquency_status: "120+", lpi: D("2026-05-01"), actions: [{ kind: "referred", at: "2026-10-05T12:00:00Z" }], hardship: null, contact_achieved: false, referral_event_present: false };
  assert.equal(consistencyErrors(ref, statusLine(ref)!).length, 1);
});
