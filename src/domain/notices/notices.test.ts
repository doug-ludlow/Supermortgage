/** §7.1–7.6 calculator mechanics beyond the T-id files (variant order, midpoint flags, window helpers, consent state, policy-change arithmetic). The T-ids themselves live in 7-<n>.spec.test.ts. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { cents } from "../../kernel/money/cents.ts";
import * as S from "./statement.ts"; import * as A from "./arm.ts"; import * as E from "./esign.ts"; import * as P from "./privacy.ts"; import * as PS from "./payoff-statement.ts";

test("7.1 statement mechanics: variant selection order, reminder panel timing, charge-off notice date, tpp and accelerated amounts", () => {
  assert.equal(S.variant({ charged_off: false, bk_chapter: "13", bk_exempt: false, successor_unacknowledged: false, tpp_active: true, accelerated: false, regx_days: 90 }), "bk_modified_12_13");
  assert.equal(S.variant({ charged_off: false, bk_chapter: null, bk_exempt: false, successor_unacknowledged: false, tpp_active: true, accelerated: false, regx_days: 90 }), "tpp");
  assert.equal(S.variant({ charged_off: true, bk_chapter: "13", bk_exempt: false, successor_unacknowledged: false, tpp_active: false, accelerated: false, regx_days: 90 }), "charged_off");
  assert.equal(S.variant({ charged_off: false, bk_chapter: null, bk_exempt: false, successor_unacknowledged: false, tpp_active: false, accelerated: false, regx_days: 46 }), "delinquent");
  assert.deepEqual(S.reminderPanel(D("2026-10-17"), true, false), { panel: true, standalone_by: "2026-10-20" }); assert.equal(S.reminderPanel(D("2026-10-12"), true, false).panel, false); assert.equal(S.reminderPanel(D("2026-10-17"), true, true).standalone_by, null);
  assert.equal(S.chargeOffNoticeDue(D("2026-11-03")), "2026-12-03");
  assert.equal(S.amountDue({ current_payment_cents: cents("2946.79"), past_due_cents: 0n, late_charges_cents: 0n, fees_cents: 0n, suspense_cents: 0n, tpp_payment_cents: cents("2100") }).amount_due_cents, cents("2100"));
  assert.equal(S.amountDue({ current_payment_cents: cents("2946.79"), past_due_cents: cents("5893.58"), late_charges_cents: 0n, fees_cents: 0n, suspense_cents: 0n, accelerated_reinstatement_cents: cents("6127.00") }).amount_due_cents, cents("6127.00"));
});

test("7.2 ARM mechanics: floor and lifetime bounds, midpoint flag, window helpers, correction sign (actual − re-amortized = overcharge)", () => {
  const base = { margin_pct: "2.750", prior_rate_pct: "5.750", initial_note_rate_pct: "5.750", initial_cap_pct: "2.000", periodic_cap_pct: "1.000", lifetime_cap_pct: "5.000", first_change: true };
  assert.equal(A.newRate({ ...base, index_pct: "0.1", first_change: false }).new_rate_pct, "4.750");
  assert.equal(A.newRate({ ...base, index_pct: "9.0", first_change: false, prior_rate_pct: "10.000" }).new_rate_pct, "10.750");
  assert.deepEqual([A.newRate({ ...base, index_pct: "-0.500", prior_rate_pct: "3.000", periodic_cap_pct: "5.000", first_change: false }).bound, A.newRate({ ...base, index_pct: "-0.500", prior_rate_pct: "3.000", periodic_cap_pct: "5.000", first_change: false }).new_rate_pct], ["floor", "2.750"]);   // rate never below the margin
  assert.equal(A.newRate({ ...base, index_pct: "3.6875" }).midpoint_flag, true);
  assert.deepEqual(A.noticeWindow(D("2026-12-01"), D("2026-11-01"), 45).window_opened_event.payload, { kind: "c", opens_on: "2026-08-03", deadline: "2026-10-02", first_new_payment_due: "2026-12-01" });
  // the spec writes net_effect = reamortized − actual "(positive = overcharge)"; the engine keeps positive = overcharge with the arithmetically correct sign (actual − reamortized) — see docs/audit notes
  assert.deepEqual(A.correction(cents("999.00"), cents("1000.50"), true, false), { net_effect_cents: 150n, treatment: "cash_refund" });
  assert.deepEqual(A.correction(cents("999.00"), cents("1000.50"), false, false), { net_effect_cents: 150n, treatment: "credit_reallocation" });
  assert.deepEqual(A.correction(cents("1000.50"), cents("999.00"), true, false), { net_effect_cents: -150n, treatment: "absorbed" });            // undercharge: never collected
  assert.deepEqual(A.correction(cents("1000.00"), cents("1000.75"), true, false), { net_effect_cents: 75n, treatment: "credit_reallocation" });   // ≤ $1.00: credit
});

test("7.3 initial-notice mechanics: status by term and consummation, window-opened event, index freshness", () => {
  const w = A.initialNoticeWindow(D("2026-12-01"), D("2021-11-15"), 360); assert.deepEqual([w.status, w.not_before, w.deadline], ["servicer", "2026-04-05", "2026-05-05"]);
  assert.equal(w.window_opened_event.type, "arm.initial_notice.window_opened");
  assert.equal(A.initialNoticeWindow(D("2026-12-01"), D("2026-06-01"), 360).status, "originator_duty"); assert.equal(A.initialNoticeWindow(D("2026-12-01"), D("2021-11-15"), 12).status, "exempt_short_term");
  assert.equal(A.indexFreshForInitial({ effective_date: D("2026-04-20"), value: "3.64381" }, D("2026-04-20")), true); assert.equal(A.indexFreshForInitial({ effective_date: D("2026-03-20"), value: "3.6" }, D("2026-04-20")), false);
});

test("7.4 consent mechanics: bounce kinds, evidence-only transfer rows, revocation deadline, verification expiry", () => {
  const c = E.newConsent("p1", ["periodic_statements"], "1.3", D("2026-10-01"), "portal") as E.Consent; E.verify(c, true, true, D("2026-10-03"));
  assert.deepEqual(E.bounce(c, "soft"), { mail_same_day: false }); assert.equal(c.status, "active"); E.bounce(c, "soft"); assert.deepEqual(E.bounce(c, "soft"), { mail_same_day: true }); assert.equal(c.status, "suspect");   // three soft bounces in 30 days
  const c2 = E.newConsent("p3", ["a"], "1.3", D("2026-10-01"), "portal") as E.Consent; E.verify(c2, true, true, D("2026-10-02")); assert.deepEqual(E.bounce(c2, "complaint"), { mail_same_day: true }); assert.equal(c2.status, "withdrawn");
  assert.equal((E.newConsent("p5", ["a"], "1.3", D("2026-10-01"), "api_transfer_in") as E.Consent).status, "evidence_only");
  assert.equal(E.tcpaRevocationDeadline(D("2026-10-14")), "2026-10-28"); assert.equal(E.verificationExpires(c), "2026-10-08");
});

test("7.5 privacy mechanics: initial-notice triggers, annual exception inputs, 100-day and 30-day arithmetic", () => {
  assert.equal(P.initialNoticeRequired("msr_acquisition"), true); assert.equal(P.initialNoticeRequired("master_to_sub"), false); assert.equal(P.initialNoticeDue(D("2026-11-02")), "2026-12-02");
  assert.equal(P.annualExceptionEligible("exceptions_only", true), true); assert.equal(P.annualExceptionEligible("broader", true), false);
  assert.equal(P.policyChange(true, true, D("2027-06-15"), D("2027-07-01")).opt_out_window_ends, "2027-07-31"); assert.equal(P.policyChange(false, true, D("2027-06-15")).annual_notice_due, "2027-09-23");
  assert.equal(P.portalAcknowledgmentFallback(D("2026-11-10")), "2026-12-10");
});

test("7.6 payoff mechanics: reasonable-time deadlines by reason, requester classes, per-diem arithmetic", () => {
  const rt = PS.deadline(D("2026-10-13"), "TX", "bankruptcy"); assert.equal(rt.ack_by, "2026-10-15"); assert.equal(rt.due_on, "2026-10-27");
  assert.equal(PS.requesterAuthorization("lender_or_title", false), "request_authorization_send_to_borrower"); assert.equal(PS.requesterAuthorization("attorney", true), "authorized_agent"); assert.equal(PS.requesterAuthorization("confirmed_successor", false), "consumer_request");
  const p = PS.payoff({ upb_cents: cents("371048.86"), rate_pct: "6.375", paid_through: D("2026-10-31"), good_through: D("2026-11-20") });
  assert.equal(p.per_diem_cents, 6_481n); assert.equal(p.days, 20); assert.equal(p.interest_cents, 129_613n); assert.equal(p.total_cents, cents("372344.99")); assert.equal(p.escrow_refund_cents, 0n);
});
