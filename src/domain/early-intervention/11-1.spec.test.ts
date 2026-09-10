// 11.1 Live contact
// spec/sections/11-early-intervention-collections/11-1-live-contact.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { zonedEpochMs } from "../../kernel/calendar/zoned.ts";
import { openWindow, installmentPaid, reinstateOnReversal, seedWindowsAtBoarding } from "./windows.ts";
import { inboundLiveContact, dischargedWindow, applyOngoingLossmit, selectChannel, smsRevocation, quietHoursCheck, regfRunningCounts, regfDialCheck, postConversationGate, nextOutboundDue, preSaleStop, promiseFollowUp, aiQrpcWithFlagOff, humanTransferRequest, boardingCallTaskDue, regxApplicability, recordingDisclosureCheck, noticeActionAfterReversal, type CallAttempt } from "./ops.ts";

// 11.1-T1 — implemented in src/domain/early-intervention/early-intervention.test.ts
// 11.1-T2 — implemented in src/domain/early-intervention/early-intervention.test.ts
// 11.1-T3 — implemented in src/domain/early-intervention/early-intervention.test.ts
// 11.1-T4 — implemented in src/domain/early-intervention/early-intervention.test.ts
test("11.1-T5: Given the borrower calls in on day 20 and completes a verified conversation, then the window is `satisfied_live` with `basis=borrower_initiated` and the Fannie Mae plan records an inbound contact.", () => {
  const ws = [openWindow(D("2026-11-01"), { principal_residence: true })];
  const r = inboundLiveContact(ws, D("2026-11-21"));
  assert.equal(r.satisfied.length, 1); assert.equal(ws[0]!.live, "satisfied_live"); assert.equal(ws[0]!.live_basis, "borrower_initiated"); assert.equal(r.basis, "borrower_initiated");
  assert.deepEqual(r.plan_record, { type: "contact.inbound.received", direction: "inbound", on: D("2026-11-21") });
});
// 11.1-T6 — implemented in src/domain/early-intervention/early-intervention.test.ts
// 11.1-T7 — implemented in src/domain/early-intervention/early-intervention.test.ts
test("11.1-T8: Given a Chapter 7 discharge, then no window ever reopens for (a) after the case closes, even on new delinquency; a later partial payment triggers the 11.2 notice path only.", () => {
  const a = dischargedWindow(D("2027-06-01"), { payment_after_petition: false });
  assert.equal(a.live, "exempt_discharge"); assert.equal(a.notice, "exempt_discharge");
  const b = dischargedWindow(D("2027-07-01"), { payment_after_petition: true });
  assert.equal(b.live, "exempt_discharge"); assert.equal(b.notice, "open");
});
test("11.1-T9: Given `lossmit.ongoing_contact` active from day 30 to day 70, then windows maturing in that span are `satisfied_ongoing_lossmit`; after cure and re-delinquency, new windows require fresh efforts.", () => {
  const day0 = D("2026-11-01");
  const ws = [openWindow(D("2026-11-01"), { principal_residence: true }), openWindow(D("2026-12-01"), { principal_residence: true })];
  const hit = applyOngoingLossmit(ws, D("2026-12-01"), D("2027-01-10"));   // day 30 → day 70 of the Nov 1 delinquency
  assert.equal(hit.length, 2); assert.ok(ws.every((w) => w.live === "satisfied_ongoing_lossmit"));
  const fresh = openWindow(D("2027-03-01"), { principal_residence: true }); assert.equal(applyOngoingLossmit([fresh], D("2026-12-01"), D("2027-01-10")).length, 0); assert.equal(fresh.live, "open");
  assert.equal(day0, "2026-11-01");
});
test("11.1-T10: Given a mobile number with no `tcpa_voice` consent, when the planner selects a channel, then AI voice is refused (`TCPA_64_1200_A1_CELL_CONSENT_GATE`) and a human manual-dial task is created.", () => {
  const r = selectChannel({ line_type: "mobile", tcpa_voice_consent: false });
  assert.equal(r.ai_voice, false); assert.equal(r.refused_by, "TCPA_64_1200_A1_CELL_CONSENT_GATE"); assert.equal(r.task, "human_manual_dial"); assert.equal(r.route, "human_manual_dial");
  assert.equal(selectChannel({ line_type: "mobile", tcpa_voice_consent: true }).ai_voice, true);
});
test("11.1-T11: Given an inbound SMS \"STOP\", then `consent.revoked` is committed within 1 minute, all AI voice/SMS to that number are blocked, one confirmation text is sent within 5 minutes, and `TCPA_64_1200_A10_REVOCATION_HONOR_10BD` is satisfied immediately.", () => {
  const t0 = zonedEpochMs(D("2026-12-11"), "10:00", "America/Chicago");
  const r = smsRevocation({ received_at_ms: t0, text: "STOP", received_on: D("2026-12-11") });
  assert.equal(r.revoked, true); assert.equal(r.committed_by_ms, t0 + 60_000); assert.deepEqual(r.blocked, ["ai_voice", "sms"]);
  assert.deepEqual(r.confirmation_text, { count: 1, send_by_ms: t0 + 300_000 });
  assert.equal(r.timer.code, "TCPA_64_1200_A10_REVOCATION_HONOR_10BD"); assert.equal(r.timer.status, "satisfied"); assert.equal(r.timer.satisfied_at_ms, t0);
  assert.equal(smsRevocation({ received_at_ms: t0, text: "thanks", received_on: D("2026-12-11") }).revoked, false);
});
test("11.1-T12: Given property in America/New_York and area code in America/Los_Angeles, when dialing at 20:45 ET, then the call is refused (17:45 PT is allowed but 20:45 ET exceeds the 20:30 voice policy); at 11:00 ET (08:00 PT) it is refused for PT; at 12:00 ET it is permitted.", () => {
  const tz = ["America/New_York", "America/Los_Angeles"];
  const a = quietHoursCheck({ dial_at_ms: zonedEpochMs(D("2026-12-09"), "20:45", "America/New_York"), time_zones: tz, mode: "voice" });
  assert.equal(a.permitted, false); assert.deepEqual(a.refused_for, [{ tz: "America/New_York", local: "20:45" }]);
  const b = quietHoursCheck({ dial_at_ms: zonedEpochMs(D("2026-12-09"), "11:00", "America/New_York"), time_zones: tz, mode: "voice" });
  assert.equal(b.permitted, false); assert.deepEqual(b.refused_for, [{ tz: "America/Los_Angeles", local: "08:00" }]);
  assert.equal(quietHoursCheck({ dial_at_ms: zonedEpochMs(D("2026-12-09"), "12:00", "America/New_York"), time_zones: tz, mode: "voice" }).permitted, true);
});
test("11.1-T13: Given the Reg F scenario in rule 10, then counts are B=1,2,2,2,3,4 and C=1 in order; the 12-15 callback is `regf_exclusion=consent_within_7d`; an attempted 8th counted call to B within 7 days is refused.", () => {
  const ET = "America/New_York"; const at = (d: string, t: string) => zonedEpochMs(D(d), t, ET);
  const attempts: CallAttempt[] = [
    { at_ms: at("2026-12-07", "09:05"), person: "B", outcome: "no_answer" }, { at_ms: at("2026-12-08", "18:40"), person: "B", outcome: "voicemail_lcm_left" },
    { at_ms: at("2026-12-09", "12:10"), person: "B", outcome: "busy_or_failed" }, { at_ms: at("2026-12-09", "12:15"), person: "C", outcome: "no_answer" },
    { at_ms: at("2026-12-10", "08:30"), person: "B", outcome: "no_answer" }, { at_ms: at("2026-12-11", "18:05"), person: "B", outcome: "conversation" },
  ];
  assert.deepEqual(regfRunningCounts(attempts, "B"), [1, 2, 2, 2, 3, 4]); assert.deepEqual(regfRunningCounts(attempts, "C"), [0, 0, 0, 1, 1, 1]);
  const cb = regfDialCheck(attempts, "B", at("2026-12-15", "18:00"), { callback_consent_at_ms: at("2026-12-11", "18:05") });
  assert.equal(cb.allowed, true); assert.equal(cb.regf_exclusion, "consent_within_7d");
  const seven: CallAttempt[] = Array.from({ length: 7 }, (_, k) => ({ at_ms: at("2026-12-07", "09:00") + k * 3_600_000, person: "B", outcome: "no_answer" }));
  const eighth = regfDialCheck(seven, "B", at("2026-12-08", "09:00"));
  assert.equal(eighth.allowed, false); assert.equal(eighth.refused_by, "REGF_1006_14_CALL_CAP_7IN7"); assert.equal(eighth.count_after, 8);
});
test("11.1-T14: Given a conversation on 12-11 with no callback consent, when a dial to B is requested 12-16, then refused by `REGF_1006_14_POST_CONVERSATION_7`; permitted 12-18.", () => {
  const r = postConversationGate(D("2026-12-11"), D("2026-12-16"));
  assert.equal(r.allowed, false); assert.equal(r.refused_by, "REGF_1006_14_POST_CONVERSATION_7"); assert.equal(r.permitted_from, D("2026-12-18"));
  assert.equal(postConversationGate(D("2026-12-11"), D("2026-12-18")).allowed, true);
  assert.equal(postConversationGate(D("2026-12-11"), D("2026-12-15"), { callback_consent: true }).allowed, true);
});
test("11.1-T15: Given last attempt Thu 2026-11-19 and the servicer closed Thu 11-26 (Thanksgiving), then `FNMA_D2202_OUTBOUND_EVERY_7` due 11-26 shifts to Fri 11-27.", () => {
  const r = nextOutboundDue(D("2026-11-19"));
  assert.equal(r.nominal, D("2026-11-26")); assert.equal(r.due, D("2026-11-27")); assert.equal(r.shifted, true);
  assert.equal(nextOutboundDue(D("2026-11-10")).due, D("2026-11-17"));
});
test("11.1-T16: Given a judicial sale scheduled 2027-06-15, then outbound attempts are refused from 2027-04-16; given `contact_required_through_sale` for the state, then permitted with a logged basis.", () => {
  const r = preSaleStop({ sale_date: D("2027-06-15"), judicial: true });
  assert.equal(r.stop_from, D("2027-04-16")); assert.equal(r.gate, "FNMA_D2202_CEASE_PRE_SALE_60J");
  assert.deepEqual(r.attemptAllowed(D("2027-04-16")), { allowed: false, refused_by: "FNMA_D2202_CEASE_PRE_SALE_60J", logged_basis: null });
  assert.equal(r.attemptAllowed(D("2027-04-15")).allowed, true);
  const req = preSaleStop({ sale_date: D("2027-06-15"), judicial: true, contact_required_through_sale: true }).attemptAllowed(D("2027-05-01"));
  assert.equal(req.allowed, true); assert.equal(req.logged_basis, "jurisdiction_rules.contact_required_through_sale");
  assert.equal(preSaleStop({ sale_date: D("2027-06-15"), judicial: false }).stop_from, D("2027-05-16"));
});
test("11.1-T17: Given a promise to pay by 2026-12-28 recorded 12-11, then the plan is `ceased{ptp_pending}`; when no covering payment exists at 12-29 00:05, then `promise_to_pay.broken` and the plan resumes the same day.", () => {
  const base = { promised_cents: 416500n, due_on: D("2026-12-28"), recorded_on: D("2026-12-11"), total_delinquent_cents: 416500n };
  const pending = promiseFollowUp({ ...base, covering_payment_cents: null, check_on: D("2026-12-20") });
  assert.equal(pending.plan_after_promise, "ceased{ptp_pending}"); assert.equal(pending.check.event, null);
  const broken = promiseFollowUp({ ...base, covering_payment_cents: null, check_on: D("2026-12-29") });
  assert.equal(broken.check.event, "promise_to_pay.broken"); assert.equal(broken.check.plan, "active"); assert.equal(broken.check.resumed_on, D("2026-12-29"));
  assert.equal(promiseFollowUp({ ...base, covering_payment_cents: 416500n, check_on: D("2026-12-29") }).check.event, "promise_to_pay.kept");
});
test("11.1-T18: Given `live_contact.ai_voice_counts=false` for state XX, when the AI completes a QRPC dialog on day 22, then `live_contact=false`, `SM_LIVE_CONTACT_HUMAN_FALLBACK_5CD` is due day 31, and a human-verified join on the same call sets a second `contacts` row with `live_contact=true`.", () => {
  const off = aiQrpcWithFlagOff({ due_date: D("2026-11-01"), ai_conversation_on: D("2026-11-23"), human_join: false });
  assert.deepEqual(off.contacts, [{ mode: "ai_voice", live_contact: false, live_contact_basis: "ai_voice_flag_off" }]);
  assert.deepEqual(off.fallback_timer, { code: "SM_LIVE_CONTACT_HUMAN_FALLBACK_5CD", due: D("2026-12-02") }); assert.equal(off.window_live, "open");
  const join = aiQrpcWithFlagOff({ due_date: D("2026-11-01"), ai_conversation_on: D("2026-11-23"), human_join: true });
  assert.equal(join.contacts.length, 2); assert.equal(join.contacts[1]!.live_contact, true); assert.equal(join.contacts[1]!.mode, "human_voice"); assert.equal(join.window_live, "satisfied_live");
});
test("11.1-T19: Given the borrower says \"I want a person,\" then a warm transfer starts within 10 s, `human_transfer_requested=true`, and the call's live-contact status is determined by the human leg.", () => {
  const t0 = 1_700_000_000_000;
  const r = humanTransferRequest({ utterance: "I want a person", requested_at_ms: t0 });
  assert.equal(r.warm_transfer, true); assert.equal(r.start_by_ms, t0 + 10_000); assert.equal(r.human_transfer_requested, true); assert.equal(r.live_contact_determined_by, "human_leg");
  assert.equal(humanTransferRequest({ utterance: "yes that works", requested_at_ms: t0 }).warm_transfer, false);
});
test("11.1-T20: Given transfer-in on 2026-10-01 with earliest unpaid due 2026-08-01 (61 days), then window(Aug 1) is `breached_at_boarding`, window(Sep 1) live due 2026-10-07, and a human call task is due 2026-10-03.", () => {
  const ws = seedWindowsAtBoarding([D("2026-08-01"), D("2026-09-01")], D("2026-10-01"));
  assert.equal(ws[0]!.live, "breached_at_boarding"); assert.equal(ws[0]!.notice, "breached_at_boarding");
  assert.equal(ws[1]!.live, "open"); assert.equal(ws[1]!.live_due_at, D("2026-10-07"));
  assert.equal(boardingCallTaskDue(D("2026-10-01")), D("2026-10-03"));
});
test("11.1-T21: Given a landline with no written consent, when a 4th AI-voice call in 30 days is requested, then refused and routed to human dial.", () => {
  const r = selectChannel({ line_type: "landline", tcpa_voice_consent: false, written_consent: false, ai_voice_attempts_30d: 3 });
  assert.equal(r.ai_voice, false); assert.equal(r.refused_by, "TCPA_64_1200_A3_LANDLINE_AI_3IN30"); assert.equal(r.route, "human_manual_dial");
  assert.equal(selectChannel({ line_type: "landline", tcpa_voice_consent: false, written_consent: false, ai_voice_attempts_30d: 2 }).ai_voice, true);
  assert.equal(selectChannel({ line_type: "landline", tcpa_voice_consent: false, written_consent: true, ai_voice_attempts_30d: 9 }).ai_voice, true);
});
test("11.1-T22: Given an investment property, then no Reg X window is created (`not_applicable`) but `FNMA_D2202_OUTBOUND_START_36` and the 7-day cadence run.", () => {
  const r = regxApplicability({ principal_residence: false, due_date: D("2026-11-01") });
  assert.equal(r.regx_window, "not_applicable"); assert.equal(r.fnma.start.code, "FNMA_D2202_OUTBOUND_START_36"); assert.equal(r.fnma.start.due, D("2026-12-07")); assert.equal(r.fnma.cadence_every_days, 7);
  assert.equal(openWindow(D("2026-11-01"), { principal_residence: false }).live, "exempt_investment");
  assert.equal(regxApplicability({ principal_residence: true, due_date: D("2026-11-01") }).regx_window, "applies");
});
test("11.1-T23: Given a two-party-consent state, then the recording disclosure is present in the first 15 s of every recorded call transcript (automated check, 100 %).", () => {
  const ok = recordingDisclosureCheck({ two_party_state: true, transcript: [{ t_s: 3, text: "I'm an automated assistant for Supermortgage. This call is recorded." }, { t_s: 20, text: "How can I help?" }] });
  assert.equal(ok.compliant, true); assert.equal(ok.present_within_15s, true);
  const late = recordingDisclosureCheck({ two_party_state: true, transcript: [{ t_s: 3, text: "Hello" }, { t_s: 22, text: "This call is recorded." }] });
  assert.equal(late.compliant, false);
  assert.equal(recordingDisclosureCheck({ two_party_state: false, transcript: [{ t_s: 3, text: "Hello" }] }).compliant, true);
});
test("11.1-T24: Given `payment.reversed` (NSF) on 2026-12-15 for the Dec 10 application, then installment Nov 1 reopens, window(Nov 1) notice leg is reinstated with `cancel_reason` cleared and `notice_due_at` unchanged (2026-12-16), and 11.2 issues the notice by 12-16 if not already sent.", () => {
  const w = openWindow(D("2026-11-01"), { principal_residence: true });
  installmentPaid(w, D("2026-12-10")); assert.equal(w.notice, "cancelled_paid"); assert.equal(w.cancel_reason, "paid_before_45");
  const r = reinstateOnReversal(w);
  assert.equal(r.notice_reinstated, true); assert.equal(r.live_reinstated, false); assert.equal(w.notice, "open"); assert.equal(w.cancel_reason, null); assert.equal(w.notice_due_at, D("2026-12-16"));
  assert.deepEqual(noticeActionAfterReversal(w, false), { notice_due_at: D("2026-12-16"), action: "issue_by_due" });
  assert.equal(noticeActionAfterReversal(w, true).action, "none_already_sent");
});

test("11.1 worked figures: P $2,000.00 = $1,650.00 + $350.00; two $1,200.00 partials → $2,400.00 suspense applies $2,000.00 and leaves $400.00; late charge $82.50 (5% of P&I); past due $4,165.00; promise $4,000.00", () => {
  assert.equal(165000n + 35000n, 200000n); assert.equal(120000n + 120000n, 240000n); assert.equal(240000n - 200000n, 40000n);
  assert.equal((165000n * 5n) / 100n, 8250n); assert.equal(2n * 200000n + 2n * 8250n, 416500n); assert.ok(400000n < 416500n);
});
