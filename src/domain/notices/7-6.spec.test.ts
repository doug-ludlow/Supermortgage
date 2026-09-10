// 7.6 Payoff statement
// spec/sections/07-compliance-notices-disclosures/7-6-payoff-statement.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { MemoryEventStore, FixedClock, SYSTEM } from "../../kernel/events/index.ts";
import { TimerEngine } from "../../kernel/timers/engine.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";
import { deadline, federalDeadline, businessDaysAfterRequest, payoff, perDiem, payoffBeforeScheduledPayment, requesterAuthorization } from "./payoff-statement.ts";
import { payoffClockStart, oralPayoffRequest, authorizationRequest, reasonableTimePath, updatedPayoffStatement, successorPayoffRequest, noePayoffLink, scheduledUpbAfter } from "./ops.ts";

const rig = (iso: string) => { const clock = new FixedClock(iso); const events = new MemoryEventStore(clock); const engine = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["7.6"] }); return { clock, events, engine }; };
const published = () => { const reg = buildRegistry(); publishAuthored(reg); return reg; };

test("7.6-T1: Given a written request emailed Tue 2026-10-13 09:40 and the servicer open on standard weekdays, then the federal deadline is Thu 2026-10-22 and a send on 2026-10-23 breaches with sev-1.", () => {
  assert.equal(federalDeadline(D("2026-10-13")), "2026-10-22"); assert.deepEqual(deadline(D("2026-10-13"), "TX"), { due_on: "2026-10-22", state_due_on: null, ack_by: null, basis: "federal 7 BD" });
  const { events, engine } = rig("2026-10-13T14:40:00.000Z");                                                              // 09:40 CDT
  events.append({ type: "payoff.request.received", loanId: "L-1", actor: SYSTEM, payload: { written: true, channel: "email", received_at: "2026-10-13T14:40:00.000Z" } });
  const t = engine.byCode("REGZ_1026_36C3_PAYOFF_STMT_7BD")[0]!; assert.equal(t.dueDate, "2026-10-22"); assert.equal(t.status, "armed");
  assert.ok(!engine.evaluate("2026-10-22T20:00:00.000Z").some((b) => b.def.code === "REGZ_1026_36C3_PAYOFF_STMT_7BD"));
  const breach = engine.evaluate("2026-10-23T12:00:00.000Z").find((b) => b.def.code === "REGZ_1026_36C3_PAYOFF_STMT_7BD")!;
  assert.equal(breach.severity, 1); assert.equal(t.status, "breached"); assert.match(breach.breachText, /1024\.35\(b\)\(6\)/);
  events.append({ type: "payoff.statement.sent", loanId: "L-1", actor: SYSTEM, payload: { template: "NTC_REGZ_36C3_PAYOFF_STMT" } }); assert.equal(t.status, "satisfied_late");
});
test("7.6-T2: Given the same request by mail received by the scanning vendor 2026-10-13, then the clock starts 2026-10-13 (vendor receipt date, not postmark).", () => {
  const r = payoffClockStart({ channel: "mail", received_on: D("2026-10-13"), postmark_on: D("2026-10-09"), vendor_receipt_on: D("2026-10-13") });
  assert.equal(r.clock_start, "2026-10-13"); assert.match(r.basis, /vendor receipt date/); assert.equal(r.federal_due, "2026-10-22");
  assert.equal(payoffClockStart({ channel: "email", received_on: D("2026-10-13") }).federal_due, "2026-10-22");
});
test("7.6-T3: Given a Florida property, then the deadline is the earlier of 2026-10-22 and 2026-10-23 (10 calendar days) and the statement contains no disclaimer language.", () => {
  const fl = deadline(D("2026-10-13"), "FL"); assert.equal(fl.due_on, "2026-10-22"); assert.equal(fl.state_due_on, "2026-10-23"); assert.match(fl.basis, /earlier of/);
  const { events, engine } = rig("2026-10-13T14:40:00.000Z");
  events.append({ type: "payoff.request.received", loanId: "L-1", actor: SYSTEM, payload: { written: true, state: "FL" } });
  assert.equal(engine.byCode("STATE_FL_701_04_ESTOPPEL_10")[0]!.dueDate, "2026-10-23"); assert.equal(engine.byCode("REGZ_1026_36C3_PAYOFF_STMT_7BD")[0]!.dueDate, "2026-10-22");
  const reg = published(); const v = reg.activeVersion("NTC_REGZ_36C3_PAYOFF_STMT", D("2026-10-15"))!;
  const clean = { ...v.samplePayload, state: "FL", state_text: "Florida Statutes section 701.04: the unpaid balance stated here may be relied on as of the good-through date." };
  const r = render(v.source, clean); assert.doesNotMatch(r.text, /reserve the right|subject to change|disclaim/i); assert.equal(evaluateChecklist(v, clean, r).passed, true);
  const disclaimer = { ...clean, state_text: "We reserve the right to change these figures." };
  assert.ok(evaluateChecklist(v, disclaimer, render(v.source, disclaimer)).blocking.some((b) => b.rule_id === "fl-no-disclaimer"));
});
test("7.6-T4: Given a California property and a request from a licensed escrow holder, then the 21-day state timer runs alongside the federal 7-BD timer and the fee line is $0 (cap $30 unused).", () => {
  const ca = deadline(D("2026-10-13"), "CA"); assert.equal(ca.due_on, "2026-10-22"); assert.equal(ca.state_due_on, "2026-11-03"); assert.match(ca.basis, /21 days alongside/);
  assert.equal(requesterAuthorization("lender_or_title", true), "authorized_agent");                                        // licensed escrow holder with the escrow instructions naming it
  const { events, engine } = rig("2026-10-13T14:40:00.000Z");
  events.append({ type: "payoff.request.received", loanId: "L-1", actor: SYSTEM, payload: { written: true, state: "CA", requester_type: "title_escrow" } });
  assert.equal(engine.byCode("STATE_CA_CC2943_PAYOFF_21")[0]!.dueDate, "2026-11-03"); assert.equal(engine.byCode("REGZ_1026_36C3_PAYOFF_STMT_7BD")[0]!.dueDate, "2026-10-22");
  const reg = published(); const v = reg.activeVersion("NTC_REGZ_36C3_PAYOFF_STMT", D("2026-10-15"))!;
  const p = { ...v.samplePayload, state: "CA", requester_name: "Golden Escrow Inc. (licensed escrow holder)", state_text: "California Civil Code section 2943 payoff demand statement: fee for this statement $0.00 (statutory cap $30.00 not charged); this statement may be relied on through the earlier of close of escrow, transfer of title or recordation of a lien.", fee_cents: 0n };
  const r = render(v.source, p); assert.match(r.text, /fee for this statement \$0\.00/); assert.equal(evaluateChecklist(v, p, r).passed, true);
  const noCa = { ...p, state_text: null }; assert.ok(evaluateChecklist(v, noCa, render(v.source, noCa)).blocking.some((b) => b.rule_id === "ca-2943"));
});
test("7.6-T5: Given an oral request by AI voice, then a quote is given per 16.1, no §1026.36(c)(3) timer starts, and the borrower is offered a one-click written request; given the click, then the timer starts at the click time.", () => {
  const oral = oralPayoffRequest({ channel: "ai_voice", clicked_written_at: null });
  assert.equal(oral.quote, "16.1_engine"); assert.equal(oral.timer_started, false); assert.equal(oral.written_offer, "one_click_written_request");
  const clicked = oralPayoffRequest({ channel: "ai_voice", clicked_written_at: "2026-10-13T14:41:00-05:00" });
  assert.equal(clicked.timer_started, true); assert.equal(clicked.timer_started_at, "2026-10-13T14:41:00-05:00");
});
test("7.6-T6: Given a request from a title company without authorization, then an authorization request goes out the same day and, absent authorization by day 7, the statement is sent to the borrower of record and the timer is satisfied.", () => {
  const r = authorizationRequest({ received_on: D("2026-10-13"), requester_type: "lender_or_title", evidence: false });
  assert.equal(r.classification, "request_authorization_send_to_borrower"); assert.equal(r.request_notice, "NTC_PAYOFF_AUTHORIZATION_REQUEST"); assert.equal(r.request_send_by, "2026-10-13");
  assert.equal(r.federal_due, "2026-10-22"); assert.equal(r.deliver_to, "borrower_of_record"); assert.equal(r.requester_told_to_obtain_from_borrower, true);
  assert.deepEqual(r.satisfying_event, { type: "payoff.statement.sent", payload: { template: "NTC_REGZ_36C3_PAYOFF_STMT", recipient: "borrower_of_record" } });
  assert.equal(authorizationRequest({ received_on: D("2026-10-13"), requester_type: "lender_or_title", evidence: false, authorization_received_on: D("2026-10-16") }).deliver_to, "requester");
  const reg = published(); const v = reg.activeVersion("NTC_PAYOFF_AUTHORIZATION_REQUEST", D("2026-10-13"))!;
  const rr = render(v.source, v.samplePayload); assert.match(rr.text, /sent to the borrower of record by October 22, 2026/); assert.equal(evaluateChecklist(v, v.samplePayload, rr).passed, true);
  const nextDay = { ...v.samplePayload, days_after_request: 1 }; assert.ok(evaluateChecklist(v, nextDay, render(v.source, nextDay)).blocking.some((b) => b.rule_id === "same-day"));   // same day, not day 2
  const { clock, events, engine } = rig("2026-10-13T14:40:00.000Z");
  events.append({ type: "payoff.request.received", loanId: "L-1", actor: SYSTEM, payload: { written: true, requester_type: "title_escrow", authorization_evidence: false } });
  const t = engine.byCode("REGZ_1026_36C3_PAYOFF_STMT_7BD")[0]!; assert.equal(t.dueDate, "2026-10-22");
  events.append({ type: "notice.sent", loanId: "L-1", actor: SYSTEM, payload: { template: "NTC_PAYOFF_AUTHORIZATION_REQUEST" } }); assert.equal(t.status, "armed");   // the clock is not tolled
  clock.set("2026-10-22T15:00:00.000Z"); events.append({ type: r.satisfying_event.type, loanId: "L-1", actor: SYSTEM, payload: r.satisfying_event.payload }); assert.equal(t.status, "satisfied");
});
test("7.6-T7: Given a loan in active foreclosure and firm fees pending, then `reasonable_time_reason = foreclosure` with the firm request as evidence, an acknowledgment is sent within 2 BD, and the statement goes out by day 10.", () => {
  const r = reasonableTimePath({ received_on: D("2026-10-13"), reason: "foreclosure", evidence_document_id: "firm-fee-request-1" });
  assert.equal(r.reasonable_time_reason, "foreclosure"); assert.equal(r.evidence_document_id, "firm-fee-request-1"); assert.equal(r.ack_notice, "NTC_PAYOFF_REQUEST_ACK_DELAY"); assert.equal(r.ack_by, "2026-10-15"); assert.equal(r.statement_by, "2026-10-27");
  assert.throws(() => reasonableTimePath({ received_on: D("2026-10-13"), reason: "foreclosure", evidence_document_id: null }), /evidence/);
  assert.throws(() => reasonableTimePath({ received_on: D("2026-10-13"), reason: "similar", evidence_document_id: "d-1" }), /officer approval/);
  const { clock, events, engine } = rig("2026-10-13T14:40:00.000Z");
  events.append({ type: "payoff.request.received", loanId: "L-1", actor: SYSTEM, payload: { written: true } });
  events.append({ type: r.event.type, loanId: "L-1", actor: SYSTEM, payload: r.event.payload });
  const ack = engine.byCode("SM_PAYOFF_DELAY_ACK_2BD")[0]!; const ten = engine.byCode("REGZ_1026_36C3_PAYOFF_REASONABLE_10BD")[0]!;
  assert.equal(ack.dueDate, "2026-10-15"); assert.equal(ten.dueDate, "2026-10-27");
  clock.set("2026-10-14T15:00:00.000Z"); events.append({ type: "notice.sent", loanId: "L-1", actor: SYSTEM, payload: { template: "NTC_PAYOFF_REQUEST_ACK_DELAY" } }); assert.equal(ack.status, "satisfied");
  clock.set("2026-10-26T15:00:00.000Z"); events.append({ type: "payoff.statement.sent", loanId: "L-1", actor: SYSTEM, payload: { template: "NTC_REGZ_36C3_PAYOFF_STMT" } }); assert.equal(ten.status, "satisfied");
  // day 9 through the shipped checklist: allowed on the documented reasonable-time path, a block otherwise
  assert.equal(businessDaysAfterRequest(D("2026-10-13"), D("2026-10-26")), 9); assert.equal(businessDaysAfterRequest(D("2026-10-13"), D("2026-10-27")), 10);
  const reg = published(); const v = reg.activeVersion("NTC_REGZ_36C3_PAYOFF_STMT", D("2026-10-26"))!;
  const day9 = { ...v.samplePayload, business_days_after_request: 9, reasonable_time_reason: "foreclosure", reasonable_time_evidence_document_id: "firm-fee-request-1" };
  assert.equal(evaluateChecklist(v, day9, render(v.source, day9)).passed, true);
  const day9Plain = { ...v.samplePayload, business_days_after_request: 9 };
  assert.deepEqual(evaluateChecklist(v, day9Plain, render(v.source, day9Plain)).blocking.map((b) => b.rule_id), ["within-7bd"]);
  const day11 = { ...day9, business_days_after_request: 11 }; assert.ok(evaluateChecklist(v, day11, render(v.source, day11)).blocking.some((b) => b.rule_id === "within-10bd-reasonable-time"));
  const ackV = reg.activeVersion("NTC_PAYOFF_REQUEST_ACK_DELAY", D("2026-10-14"))!; assert.equal(evaluateChecklist(ackV, ackV.samplePayload, render(ackV.source, ackV.samplePayload)).passed, true);
});
test("7.6-T8: Given UPB $371,048.86, rate 6.375% from Nov 1, paid-through Oct 31 and good-through Nov 20, 2026, then per diem $64.81, interest $1,296.13 and total $372,344.99 with escrow shown as refunded separately.", () => {
  const p = payoff({ upb_cents: 37104886n, rate_pct: "6.375", paid_through: D("2026-10-31"), good_through: D("2026-11-20"), escrow_balance_cents: 183000n });
  assert.equal(p.per_diem_cents, 6481n); assert.equal(p.days, 20); assert.equal(p.interest_cents, 129613n); assert.equal(p.total_cents, 37234499n);
  assert.equal(p.escrow_treatment, "refund_separately_20bd"); assert.equal(p.escrow_refund_cents, 183000n);
  const reg = published(); const v = reg.activeVersion("NTC_REGZ_36C3_PAYOFF_STMT", D("2026-10-15"))!;
  const r = render(v.source, v.samplePayload);
  assert.match(r.text, /Total amount to pay your loan in full as of November 20, 2026: \$372,344\.99/); assert.match(r.text, /20 days at \$64\.81 per day, 365-day basis\) \$1,296\.13/); assert.match(r.text, /escrow balance of \$1,830\.00 is not deducted from the payoff and will be refunded within 20 business days after payoff/);
});
test("7.6-T9: Given an escrow tax disbursement advance posted after the statement but before the good-through date, then an updated statement is issued the same day and the original is marked superseded.", () => {
  const u = updatedPayoffStatement({ original: { id: "stmt-1", good_through: D("2026-11-20"), total_cents: 37234499n }, change: { kind: "escrow_tax_disbursement_advance", posted_on: D("2026-11-05"), delta_cents: 412000n } });
  assert.equal(u.updated, true); assert.equal(u.updated_on, "2026-11-05"); assert.equal(u.template, "NTC_PAYOFF_UPDATED_STMT"); assert.equal(u.original_status, "superseded"); assert.equal(u.new_total_cents, 37646499n); assert.equal(u.retained_original, true);
  assert.equal(updatedPayoffStatement({ original: { id: "stmt-1", good_through: D("2026-11-20"), total_cents: 37234499n }, change: { kind: "fee", posted_on: D("2026-11-25"), delta_cents: 100n } }).updated, false);
});
test("7.6-T10: Given a confirmed successor requests a payoff, then it is a consumer request (no authorization needed) and the statement is delivered to the successor.", () => {
  assert.deepEqual(successorPayoffRequest({ confirmed: true }), { classification: "consumer_request", deliver_to: "successor", authorization_needed: false });
  assert.equal(successorPayoffRequest({ confirmed: false }).authorization_needed, true);
});
test("7.6-T11: Given a NoE alleging an inaccurate payoff, then the 4.1 NoE case links to the `payoff_requests` row and the statement hash under investigation.", () => {
  assert.deepEqual(noePayoffLink({ noe_case_id: "NOE-77", payoff_request_id: "PR-12", statement_hash: "sha256:ab12" }), { case_id: "NOE-77", links: { payoff_request_id: "PR-12", statement_hash: "sha256:ab12" }, error_type: "1024.35(b)(6)", freeze_updates: false });
});

test("7.6 worked example: UPB $371,048.86 after the Nov 1 payment (alternative $371,602.55 before it), per diem $64.81 at 6.375%, escrow $1,830.00 refunded separately", () => {
  assert.equal(perDiem(37104886n, "6.375"), 6481n);
  const p = payoff({ upb_cents: 37104886n, rate_pct: "6.375", paid_through: D("2026-10-31"), good_through: D("2026-11-20"), escrow_balance_cents: 183000n });
  assert.equal(p.days, 20); assert.equal(p.per_diem_cents, 6481n); assert.equal(p.escrow_treatment, "refund_separately_20bd"); assert.equal(p.escrow_refund_cents, 183000n);
  // the alternative figure: 59 scheduled payments leave $371,602.55; the Nov 1 payment (interest at 5.750%, then principal) takes it to $371,048.86
  assert.equal(scheduledUpbAfter(40000000n, "5.750", 233429n, 59), 37160255n); assert.equal(scheduledUpbAfter(37160255n, "5.750", 233429n, 1), 37104886n);
  const alt = payoffBeforeScheduledPayment({ upb_before_payment_cents: 37160255n, old_rate_pct: "5.750", paid_through: D("2026-09-30"), change_date: D("2026-11-01"), new_rate_pct: "6.375", good_through: D("2026-11-20") });
  assert.equal(alt.upb_cents, 37160255n); assert.deepEqual(alt.segments.map((s) => [s.from, s.through, s.rate_pct, s.days]), [["2026-09-30", "2026-10-31", "5.750", 31], ["2026-10-31", "2026-11-20", "6.375", 20]]);
  assert.equal(alt.segments[0]!.per_diem_cents, perDiem(37160255n, "5.750")); assert.equal(alt.total_cents, 37160255n + alt.interest_cents);
});
