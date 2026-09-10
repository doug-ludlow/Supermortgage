/** §7.1–7.6 acceptance tests. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { zonedEpochMs, toIso } from "../../kernel/calendar/zoned.ts";
import { cents } from "../../kernel/money/cents.ts";
import { Decimal } from "../../kernel/money/decimal.ts";
import * as S from "./statement.ts"; import * as A from "./arm.ts"; import * as E from "./esign.ts"; import * as P from "./privacy.ts"; import * as PS from "./payoff-statement.ts";
import { lar83DeadlineMs } from "../investor/period.ts";

test("7.1-T1/T2/T3/T9/T10: cycle dates, delinquency box at 46 not 45, suspense (d)(5) shortfall, Sunday due → Friday file, late fee $116.71", () => {
  const c = S.cycle(D("2026-10-01"), 15); assert.deepEqual([c.courtesy_period_end, c.statement_due_by], ["2026-10-16", "2026-10-20"]);
  assert.equal(toIso(c.snapshot_at_ms), toIso(zonedEpochMs(D("2026-10-17"), "01:00", "America/New_York")));
  assert.equal(S.delinquencyBox(D("2026-10-17"), D("2026-09-01")).include, true); assert.equal(S.delinquencyBox(D("2026-10-17"), D("2026-09-01")).regx_days, 46); assert.equal(S.delinquencyBox(D("2026-10-16"), D("2026-09-01")).include, false); assert.equal(S.delinquencyBox(D("2026-10-17"), D("2026-09-01")).began_on, "2026-09-02");
  const ad = S.amountDue({ current_payment_cents: cents("2946.79"), past_due_cents: 0n, late_charges_cents: 0n, fees_cents: 0n, suspense_cents: cents("1500") }); assert.equal(ad.amount_due_cents, cents("2946.79")); assert.equal(ad.shortfall_to_complete_cents, cents("1446.79"));
  assert.equal(S.amountDue({ current_payment_cents: cents("2946.79"), past_due_cents: 0n, late_charges_cents: 0n, fees_cents: 0n, suspense_cents: 0n, tpp_payment_cents: cents("2100") }).amount_due_cents, cents("2100"));
  const c9 = S.cycle(D("2026-09-29"), 15); assert.equal(c9.statement_due_by, "2026-10-18"); assert.equal(c9.vendor_file_by, "2026-10-16");
  assert.equal(S.lateFeeLine(cents("2334.29"), "5", null), 11_671n);
  assert.equal(S.variant({ charged_off: false, bk_chapter: "13", bk_exempt: false, successor_unacknowledged: false, tpp_active: true, accelerated: false, regx_days: 90 }), "bk_modified_12_13");
  assert.equal(S.variant({ charged_off: false, bk_chapter: null, bk_exempt: false, successor_unacknowledged: false, tpp_active: true, accelerated: false, regx_days: 90 }), "tpp");
  assert.deepEqual(S.reminderPanel(D("2026-10-17"), true, false), { panel: true, standalone_by: "2026-10-20" }); assert.equal(S.reminderPanel(D("2026-10-12"), true, false).panel, false);
  assert.equal(S.chargeOffNoticeDue(D("2026-11-03")), "2026-12-03");
});

test("7.2-T1..T7: index date, eighth rounding, initial cap, payment $2,476.44, windows, legacy 25 days, LAR 83", () => {
  assert.equal(A.indexDate(D("2026-11-01"), 45), "2026-09-17");
  assert.equal(A.selectIndex([{ effective_date: D("2026-09-16"), value: "3.6" }, { effective_date: D("2026-09-17"), value: "3.64883" }, { effective_date: D("2026-09-18"), value: "3.7" }], D("2026-09-17"))!.value, "3.64883");
  const base = { margin_pct: "2.750", prior_rate_pct: "5.750", initial_note_rate_pct: "5.750", initial_cap_pct: "2.000", periodic_cap_pct: "1.000", lifetime_cap_pct: "5.000", first_change: true };
  const r = A.newRate({ ...base, index_pct: "3.64883" }); assert.equal(r.new_rate_pct, "6.375"); assert.equal(r.unrounded_pct, "6.39883"); assert.equal(r.bound, "none");
  const mid = A.newRate({ ...base, index_pct: "3.6875" }); assert.equal(mid.new_rate_pct, "6.375"); assert.equal(mid.midpoint_flag, true); assert.equal(A.newRate({ ...base, index_pct: "3.6875", rounding: "half_up" }).new_rate_pct, "6.500");
  const capped = A.newRate({ ...base, index_pct: "5.10000" }); assert.equal(capped.new_rate_pct, "7.750"); assert.equal(capped.bound, "initial");
  assert.equal(A.newRate({ ...base, index_pct: "0.1", first_change: false }).new_rate_pct, "4.750");
  assert.equal(A.newRate({ ...base, index_pct: "9.0", first_change: false, prior_rate_pct: "10.000" }).new_rate_pct, "10.750");
  assert.equal(A.newPayment(cents("371048.86"), "6.375", 300), 247_644n);
  assert.deepEqual(A.noticeWindow(D("2026-12-01"), D("2026-11-01"), 45), { not_before: "2026-08-03", deadline: "2026-10-02", sendable_from: "2026-09-17" });
  assert.equal(A.noticeWindow(D("2026-12-01"), D("2026-11-01"), 45, true).deadline, "2026-11-06");
  assert.equal(toIso(lar83DeadlineMs(D("2026-09-17"))), toIso(zonedEpochMs(D("2026-09-24"), "20:00", "America/New_York")));
  assert.deepEqual(A.correction(cents("1000.50"), cents("999.00"), true, false), { net_effect_cents: 150n, treatment: "cash_refund" });
});

test("7.3-T1/T2/T6: initial notice window Apr 5–May 5, estimate 6.375% / $2,476.44, short-term exemption, index freshness", () => {
  const w = A.initialNoticeWindow(D("2026-12-01"), D("2021-11-15"), 360); assert.deepEqual([w.status, w.not_before, w.deadline], ["servicer", "2026-04-05", "2026-05-05"]);
  assert.equal(A.initialNoticeWindow(D("2026-12-01"), D("2026-06-01"), 360).status, "originator_duty"); assert.equal(A.initialNoticeWindow(D("2026-12-01"), D("2021-11-15"), 12).status, "exempt_short_term");
  const est = A.newRate({ index_pct: "3.64381", margin_pct: "2.750", prior_rate_pct: "5.750", initial_note_rate_pct: "5.750", initial_cap_pct: "2.000", periodic_cap_pct: "1.000", lifetime_cap_pct: "5.000", first_change: true });
  assert.equal(est.new_rate_pct, "6.375"); assert.equal(A.newPayment(cents("371048.86"), est.new_rate_pct, 300), 247_644n);
  assert.equal(A.indexFreshForInitial({ effective_date: D("2026-04-20"), value: "3.64381" }, D("2026-04-20")), true); assert.equal(A.indexFreshForInitial({ effective_date: D("2026-03-20"), value: "3.6" }, D("2026-04-20")), false);
  void Decimal;
});

test("7.4-T1/T2/T3/T4/T5/T6: consent lifecycle, voice refused, per-party channel, bounces, material change, withdrawal", () => {
  const c = E.newConsent("p1", ["periodic_statements"], "1.3", D("2026-10-01"), "portal") as E.Consent; assert.equal(c.status, "pending_verification");
  E.verify(c, true, false, D("2026-10-03")); assert.equal(c.status, "pending_verification"); E.verify(c, true, true, D("2026-10-03")); assert.equal(c.status, "active");
  assert.ok("error" in E.newConsent("p1", ["x"], "1.3", D("2026-10-01"), "voice"));
  assert.deepEqual(E.channelFor([{ party_id: "p1", consent: c }, { party_id: "p2" }], "periodic_statements"), [{ party_id: "p1", channel: "electronic" }, { party_id: "p2", channel: "mail" }]);
  assert.equal(E.channelFor([{ party_id: "p1", consent: c }], "periodic_statements", true)[0]!.channel, "mail");
  assert.deepEqual(E.bounce(c, "hard"), { mail_same_day: true }); assert.equal(c.status, "suspect");
  const c2 = E.newConsent("p3", ["a"], "1.3", D("2026-10-01"), "portal") as E.Consent; E.verify(c2, true, true, D("2026-10-02")); E.materialChange([c2]); assert.equal(c2.status, "reconsent_required");
  const c3 = E.newConsent("p4", ["a"], "1.3", D("2026-10-01"), "portal") as E.Consent; E.verify(c3, true, true, D("2026-10-02")); assert.equal(E.withdraw(c3, D("2027-03-03")).effective_by, "2027-03-04"); assert.equal(c3.status, "withdrawn");
  assert.equal((E.newConsent("p5", ["a"], "1.3", D("2026-10-01"), "api_transfer_in") as E.Consent).status, "evidence_only"); assert.equal(E.irs1098Channel(false), "paper");
});

test("7.5-T1/T2/T3/T4/T5: initial-notice trigger and timing, annual exception, revised notice / 100-day rule", () => {
  assert.equal(P.initialNoticeRequired("msr_acquisition"), true); assert.equal(P.initialNoticeRequired("master_to_sub"), false); assert.equal(P.initialNoticeDue(D("2026-11-02")), "2026-12-02");
  assert.equal(P.annualExceptionEligible("exceptions_only", true), true); assert.equal(P.annualExceptionEligible("broader", true), false);
  assert.deepEqual(P.policyChange(true, true, D("2027-06-15")).opt_out_window_ends, "2027-07-15"); assert.equal(P.policyChange(false, true, D("2027-06-15")).annual_notice_due, "2027-09-23");
});

test("7.6-T1/T3/T4/T6/T7/T8: federal 7-BD clock, FL earlier-of, CA 21 days, authorization, reasonable time, per diem", () => {
  const d = PS.deadline(D("2026-10-13"), "TX"); assert.equal(d.due_on, "2026-10-22");
  const fl = PS.deadline(D("2026-10-13"), "FL"); assert.equal(fl.due_on, "2026-10-22"); assert.equal(fl.state_due_on, "2026-10-23");
  assert.equal(PS.deadline(D("2026-10-13"), "CA").state_due_on, "2026-11-03");
  const rt = PS.deadline(D("2026-10-13"), "TX", "foreclosure"); assert.equal(rt.ack_by, "2026-10-15"); assert.equal(rt.due_on, "2026-10-27");
  assert.equal(PS.requesterAuthorization("lender_or_title", false), "request_authorization_send_to_borrower"); assert.equal(PS.requesterAuthorization("confirmed_successor", false), "consumer_request");
  const p = PS.payoff({ upb_cents: cents("371048.86"), rate_pct: "6.375", paid_through: D("2026-10-31"), good_through: D("2026-11-20") });
  assert.equal(p.per_diem_cents, 6_481n); assert.equal(p.days, 20);
  assert.equal(p.interest_cents, 129_613n); assert.equal(p.total_cents, cents("372344.99"));   // 7.6-T8: $1,296.13 / $372,344.99
});
