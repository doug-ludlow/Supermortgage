// 4.5 Complaint handling / UDAAP
// spec/sections/04-customer-service-borrower-communications/4-5-complaint-handling-udaap.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { cents } from "../../kernel/money/cents.ts";
void cents;
import { texasCure, aiTranscriptMonitor, fairLendingRouting, wrongServicerResponse, complaintAnalytics, monetaryAuthority, AI_MONETARY_LIMIT_CENTS, closeConsumerFeedbackWindows } from "./ops.ts";
import { eventMatches } from "../../kernel/events/index.ts";
import { receiveInboundEmail, validateInboundEmail } from "./ops-4-5.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import * as CP from "./complaints.ts";
import { federalDays } from "./clocks.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";
import { harness, CASE_AGENT, OFFICER, ATTORNEY, ANALYST, refusedWith } from "./test-harness.ts";
const notices = () => { const reg = buildRegistry(); publishAuthored(reg); return reg; };

test('4.5-T1: Given a CFPB portal complaint received 2026-09-10, then the AI package is ready ≤5 days, `officer` approval recorded, and the portal response submitted by 2026-09-25; if "in progress," a final response by 2026-11-09.', async () => {
  assert.deepEqual(CP.cfpbDeadlines(D("2026-09-10")), { response_by: "2026-09-25", final_by: "2026-11-09" });
  const h = harness("2026-09-10T15:00:00.000Z");
  const o = (await h.run("4.5", "complaint.open", CASE_AGENT, { case_id: "cmp-1", received_on: "2026-09-10", received_at: "2026-09-10T15:00:00.000Z", source: "cfpb_portal", channel: "cfpb_portal", external_ref: "CFPB-260910-001", text: "my escrow analysis is wrong" })).output as { cfpb_response_by: string; cfpb_final_by: string };
  assert.equal(o.cfpb_response_by, "2026-09-25"); assert.equal(o.cfpb_final_by, "2026-11-09");
  assert.equal(h.timer("CFPB_PORTAL_RESPONSE_15")[0]!.dueDate, "2026-09-25"); assert.equal(h.timer("SM_COMPLAINT_RESOLVE_15")[0]!.dueDate, "2026-09-25"); assert.equal(h.timer("SM_COMPLAINT_ACK_1BD")[0]!.dueDate, "2026-09-11");
  // SM_COMPLAINT_ACK_1BD: a written complaint is acknowledged in writing — an oral acknowledgment is refused
  await assert.rejects(h.run("4.5", "complaint.acknowledge", CASE_AGENT, { case_id: "cmp-1", channel: "call" }), refusedWith("WRITTEN_ACK_FOR_WRITTEN"));
  await h.run("4.5", "complaint.acknowledge", CASE_AGENT, { case_id: "cmp-1", channel: "portal_message" }, "2026-09-11T14:00:00.000Z");
  assert.equal(h.timer("SM_COMPLAINT_ACK_1BD")[0]!.status, "satisfied"); assert.equal(h.events.ofType("case.complaint.acknowledged")[0]!.payload.written, true);
  await assert.rejects(h.run("4.5", "regulator.response.prepare", CASE_AGENT, { case_id: "cmp-1", received_on: "2026-09-10", response_text: "…", attachments: ["escrow-analysis-2026.pdf"] }), refusedWith("PII_MINIMIZED"));
  const pkg = (await h.run("4.5", "regulator.response.prepare", CASE_AGENT, { case_id: "cmp-1", received_on: "2026-09-10", response_text: "We re-ran the analysis …", attachments: ["escrow-analysis-2026.pdf"], pii_minimized: true }, "2026-09-14T15:00:00.000Z")).output as { package_id: string; ready_on: string; package_due_by: string; awaiting: string };
  assert.equal(pkg.package_due_by, "2026-09-15"); assert.ok(pkg.ready_on <= pkg.package_due_by); assert.equal(pkg.awaiting, "officer approval");
  const submit = { case_id: "cmp-1", portal: "cfpb", status: "in_progress", received_at: "2026-09-10T15:00:00.000Z", package_id: pkg.package_id };
  await assert.rejects(h.run("4.5", "regulator.response.submit", CASE_AGENT, submit), refusedWith("HUMAN_ONLY"));                // regulator responses are always human-approved
  await assert.rejects(h.run("4.5", "regulator.response.submit", ANALYST, submit), refusedWith("ROLE_DENIED"));
  const sub = (await h.run("4.5", "regulator.response.submit", OFFICER, submit, "2026-09-24T15:00:00.000Z")).output as { submitted_on: string; final_due_by: string };
  assert.deepEqual(sub, { submitted_on: "2026-09-24", status: "in_progress", final_due_by: "2026-11-09" } as unknown as typeof sub);
  const dec = h.decisions.at(-1)!; assert.equal(dec.action, "regulator.response.submit"); assert.equal(dec.approvedBy, "u-officer"); assert.equal(dec.approvedRole, "officer");
  assert.equal(h.timer("CFPB_PORTAL_RESPONSE_15")[0]!.status, "satisfied"); assert.equal(h.timer("CFPB_PORTAL_FINAL_60")[0]!.dueDate, "2026-11-09"); assert.equal(h.timer("CFPB_CONSUMER_FEEDBACK_60")[0]!.dueDate, "2026-11-23");
  await h.run("4.5", "regulator.response.submit", OFFICER, { ...submit, status: "closed" }, "2026-11-05T15:00:00.000Z");
  assert.equal(h.timer("CFPB_PORTAL_FINAL_60")[0]!.status, "satisfied");
  assert.deepEqual(closeConsumerFeedbackWindows(h.events, [{ loan_id: "L-1", case_id: "cmp-1", responded_on: D("2026-09-24") }], D("2026-11-23")), []);
  assert.deepEqual(closeConsumerFeedbackWindows(h.events, [{ loan_id: "L-1", case_id: "cmp-1", responded_on: D("2026-09-24") }], D("2026-11-24")), ["cmp-1"]);
  assert.equal(h.timer("CFPB_CONSUMER_FEEDBACK_60")[0]!.status, "satisfied");                                                  // the informational window closes by the sweep
});
test('4.5-T2: Given a phone call "you people keep charging me late fees," then a complaint case opens, the AI checks the late-charge history live, reverses any unsupported charge within authority, and the §1024.38(b)(5) script is read (transcript evidence); no NoE case opens for an oral complaint, but the written-procedure reminder is logged.', async () => {
  const h = harness("2026-09-10T15:00:00.000Z");
  await assert.rejects(h.run("4.5", "complaint.open", CASE_AGENT, { case_id: "cmp-0", received_on: "2026-09-10", source: "borrower_direct", channel: "voice_transcript", text: "" }), refusedWith("COMPLAINT_NEEDS_TEXT"));
  const p = (await h.run("4.5", "complaint.open", CASE_AGENT, { case_id: "cmp-2", received_on: "2026-09-10", source: "borrower_direct", channel: "voice_transcript", text: "you people keep charging me late fees" })).output as { is_oral: boolean; opens_noe: boolean; script_1024_38b5: boolean; linked_noe_case_id: string | null };
  assert.deepEqual([p.is_oral, p.opens_noe, p.script_1024_38b5, p.linked_noe_case_id], [true, false, true, null]);
  assert.equal(h.rt.store.get("cases", "cmp-2")!.data.case_type, "complaint"); assert.equal(h.events.ofType("case.noe.opened").length, 0);
  const reminder = h.events.ofType("contact.logged")[0]!; assert.equal(reminder.payload.script, "SCRIPT_38B5_ORAL_COMPLAINT"); assert.equal(reminder.payload.written_procedure_reminder, true);
  await h.run("4.5", "complaint.acknowledge", CASE_AGENT, { case_id: "cmp-2", channel: "call" });                              // an oral complaint is acknowledged in the call
  assert.equal(h.timer("SM_COMPLAINT_ACK_1BD")[0]!.status, "satisfied");
  h.rt.store.put("payments", "P-1", { loan_id: "L-1", late_charges: [{ assessed_on: "2026-06-16", amount_cents: 1_500n, supported: false }] }, CASE_AGENT, h.clock.now());
  const unsupported = (h.rt.store.get("payments", "P-1")!.data.late_charges as { assessed_on: string; amount_cents: bigint; supported: boolean }[]).filter((c) => !c.supported);
  const rem = (await h.run("4.5", "complaint.remediate", CASE_AGENT, { case_id: "cmp-2", fee_account: "late_charges", amount_cents: unsupported[0]!.amount_cents, assessed_on: unsupported[0]!.assessed_on, reason: "late charge without a basis" })).output as { closed_with: string; effective_date: string };
  assert.equal(rem.closed_with, "monetary_relief"); assert.equal(rem.effective_date, "2026-06-16"); assert.equal(h.ctx.ledger.balance({ scope: "loan", loanId: "L-1", account: "late_charges" }), -1_500n);
  await assert.rejects(h.run("4.1", "case.noe.open", CASE_AGENT, { case_id: "noe-oral", receipt_date: "2026-09-10", channel: "voice_transcript", assertions: [{ id: "a1", category: "b5" }] }), refusedWith("NOE_IS_WRITTEN"));
  await assert.rejects(h.run("4.5", "complaint.close", CASE_AGENT, { case_id: "cmp-2", closed_with: "explanation", dismiss_reason: "repetition" }), refusedWith("NO_DISMISS_TONE_REPETITION"));
  await assert.rejects(h.run("4.5", "complaint.close", CASE_AGENT, { case_id: "cmp-2", closed_with: "monetary_relief" }), refusedWith("ROOT_CAUSE_REQUIRED"));
  await h.run("4.5", "complaint.close", CASE_AGENT, { case_id: "cmp-2", closed_with: "monetary_relief", root_cause_code: "2.7 late charge assessment" });
  assert.equal(h.rt.store.get("cases", "cmp-2")!.data.status, "closed");
});
test("4.5-T3: Given a written version of T2, then both a complaint and an NoE (b5) case exist with linked ids and the NoE clocks govern the written response.", async () => {
  const h = harness("2026-09-10T15:00:00.000Z");
  const p = (await h.run("4.5", "complaint.open", CASE_AGENT, { case_id: "cmp-3", received_on: "2026-09-10", source: "borrower_direct", channel: "mail", text: "you charged me a late fee I don't owe" })).output as { opens_noe: boolean; linked_noe_case_id: string; response_governed_by: string };
  assert.deepEqual([p.opens_noe, p.linked_noe_case_id, p.response_governed_by], [true, "noe-cmp-3", "noe"]);
  await assert.rejects(h.run("4.5", "complaint.respond", CASE_AGENT, { case_id: "cmp-3", text: "We are reviewing." }), refusedWith("NOE_GOVERNS"));                                  // the linked NoE is not even opened yet
  const n = (await h.run("4.1", "case.noe.open", CASE_AGENT, { case_id: p.linked_noe_case_id, receipt_date: "2026-09-10", channel: "mail", linked_case_ids: ["cmp-3"], assertions: [{ id: "a1", category: "b5", description: "late fee not owed" }] })).output as { assertions: { category: string; response_due: string }[] };
  assert.deepEqual(h.rt.store.get("cases", "cmp-3")!.data.linked_case_ids, ["noe-cmp-3"]); assert.deepEqual(h.rt.store.get("cases", "noe-cmp-3")!.data.linked_case_ids, ["cmp-3"]); assert.equal(n.assertions[0]!.category, "b5");
  assert.equal(n.assertions[0]!.response_due, federalDays(D("2026-09-10"), 30)); assert.equal(h.timer("REGX_1024_35E_NOE_RESPONSE_30")[0]!.dueDate, federalDays(D("2026-09-10"), 30));
  await assert.rejects(h.run("4.5", "complaint.respond", CASE_AGENT, { case_id: "cmp-3", linked_noe_open: false, text: "We are reviewing." }), refusedWith("NOE_GOVERNS"));             // the record, not the caller's flag, decides
  await assert.rejects(h.run("4.5", "complaint.close", CASE_AGENT, { case_id: "cmp-3", closed_with: "explanation", root_cause_code: "2.7" }), refusedWith("NOE_GOVERNS"));
  await h.run("4.1", "case.noe.determine", CASE_AGENT, { case_id: "noe-cmp-3", assertion_id: "a1", determination: "error_found", records_consulted: ["fee_schedule", "jurisdiction_rules", "ledger"] });
  await h.run("4.1", "case.noe.respond", CASE_AGENT, { case_id: "noe-cmp-3", template: "NTC_REGX_35E_CORRECTION", text: "We reversed the late fee as of March 17." });
  await assert.rejects(h.run("4.5", "complaint.respond", CASE_AGENT, { case_id: "cmp-3", text: "We guarantee your modification will be approved." }), refusedWith("NO_LOSSMIT_PROMISE"));
  await h.run("4.5", "complaint.respond", CASE_AGENT, { case_id: "cmp-3", text: "What we found: the late fee was assessed in error. What we fixed and when: reversed as of March 17." });
  assert.equal(h.events.ofType("case.complaint.responded").length, 1); assert.equal(h.timer("REGX_1024_35E_NOE_RESPONSE_30")[0]!.status, "satisfied");
  await assert.rejects(h.run("4.5", "complaint.respond", CASE_AGENT, { case_id: "cmp-3", text: "You must bring your account current before we can help." }), refusedWith("NO_PAYMENT_CONDITION"));
});
test("4.5-T4: (NY) Given a NY loan and an emailed complaint, then a written acknowledgment ≤5 BD with the DFS CAU disclosure and a response ≤30 BD (or ≤15 BD if foreclosure-related).", async () => {
  assert.deepEqual(CP.nyDeadlines(D("2026-09-10"), false), { ack_by: "2026-09-17", response_by: "2026-10-23", extendable: true });                 // 30 BD, Columbus Day excluded
  assert.equal(CP.nyDeadlines(D("2026-09-10"), true).response_by, "2026-10-01");                                                                    // 15 BD if foreclosure-related
  assert.equal(CP.nyDeadlines(D("2026-09-10"), { category: "foreclosure", sale_on: D("2026-09-28") }).response_by, "2026-09-27");                  // or before the sale, whichever is earlier
  assert.equal(CP.nyDeadlines(D("2026-09-10"), { category: "payoff" }).response_by, "2026-09-21"); assert.equal(CP.nyComplaintExtension(CP.nyDeadlines(D("2026-09-10"), false)), "2026-11-03");
  assert.deepEqual(CP.nyComplaintExtension(CP.nyDeadlines(D("2026-09-10"), true)), { error: "EXTENSION_NOT_PERMITTED" });
  const h = harness("2026-09-10T15:00:00.000Z");
  const o = (await h.run("4.5", "complaint.open", CASE_AGENT, { case_id: "cmp-4", received_on: "2026-09-10", state: "NY", source: "borrower_direct", channel: "email", text: "my escrow analysis double-counted the school tax" })).output as { ny_ack_due: string; ny_response_due: string };
  assert.deepEqual([o.ny_ack_due, o.ny_response_due], ["2026-09-17", "2026-10-23"]);
  assert.equal(h.timer("NY_419_6_COMPLAINT_ACK_5BD")[0]!.dueDate, "2026-09-17"); assert.equal(h.timer("NY_419_6_COMPLAINT_RESPONSE_30BD")[0]!.dueDate, "2026-10-23");
  await h.run("4.5", "complaint.open", CASE_AGENT, { case_id: "cmp-4fc", received_on: "2026-09-10", state: "NY", source: "borrower_direct", channel: "email", ny_category: "foreclosure", text: "you scheduled a sale while my modification is pending" });
  assert.equal(h.timer("NY_419_6_COMPLAINT_RESPONSE_30BD")[1]!.dueDate, "2026-10-01");
  const v = notices().activeVersion("NTC_COMPLAINT_ACK", D("2026-09-11"))!;
  const p = { ...v.samplePayload, ny: true, response_by: "2026-10-23" }; const rr = render(v.source, p);
  assert.match(rr.text, /Under New York regulation 3 NYCRR 419\.6 you may also contact the New York State Department of Financial Services at \(800\) 342-3736\./); assert.equal(evaluateChecklist(v, p, rr).passed, true);
  const stripped = render(v.source.replace(/\{\{#if ny\}\}[\s\S]*?\{\{\/if\}\}/, ""), p); assert.ok(evaluateChecklist(v, p, stripped).blocking.some((b) => b.rule_id === "ny-419-6"));   // the checklist catches a NY ack without the DFS disclosure
  h.clock.set("2026-09-11T15:00:00.000Z"); h.events.append({ type: "notice.sent", loanId: "L-1", actor: CASE_AGENT, payload: { template: "NTC_COMPLAINT_ACK", case_id: "cmp-4" } });
  assert.equal(h.timer("NY_419_6_COMPLAINT_ACK_5BD")[0]!.status, "satisfied");
  const resp = notices().activeVersion("NTC_COMPLAINT_RESPONSE", D("2026-10-23"))!; const rp = { ...resp.samplePayload, ny: true }; const rs = render(resp.source.replace(/\{\{#if ny\}\}[\s\S]*?\{\{\/if\}\}/, ""), rp);
  assert.ok(evaluateChecklist(resp, rp, rs).blocking.some((b) => b.rule_id === "ny-dfs"));
});
test("4.5-T5: (Texas) Given a §50(a)(6) loan and a letter alleging a constitutional defect, then `attorney`/`officer` escalation, Form 20 package prepared, and the 60-day cure timer started on the notice date.", async () => {
  assert.deepEqual(texasCure(D("2026-09-10")), { escalate: ["attorney", "officer"], package: "form_20", cure_by: "2026-11-09", timer: "TX_50A6_CURE_60" });
  assert.equal(CP.tx50a6Allegation("Your lender violated Article XVI, Section 50(a)(6) of the Texas Constitution: the fees exceeded the cap."), true); assert.equal(CP.tx50a6Allegation("my escrow analysis is wrong"), false);
  const h = harness("2026-09-10T15:00:00.000Z");
  const o = (await h.run("4.5", "complaint.open", CASE_AGENT, { case_id: "cmp-5", received_on: "2026-09-10", state: "TX", source: "attorney_demand", channel: "attorney", tx_50a6_loan: true, text: "Notice under Texas Constitution art. XVI §50(a)(6)(Q)(x): the home-equity loan closed with fees above the 2% cap — a constitutional defect you must cure within 60 days." })).output as { tx_50a6_defect_alleged: boolean; tx_50a6: { escalate: string[]; package: string; cure_by: string; escalation_ids: string[] } };
  assert.equal(o.tx_50a6_defect_alleged, true); assert.deepEqual([o.tx_50a6.escalate, o.tx_50a6.package, o.tx_50a6.cure_by], [["attorney", "officer"], "form_20", "2026-11-09"]);
  assert.deepEqual(h.rt.escalations.opened.map((e) => [e.kind, e.ownerRole, e.severity, e.caseId]), [["attorney", "attorney", "sev-1", "cmp-5"], ["officer", "officer", "sev-1", "cmp-5"]]);
  assert.equal(h.rt.escalations.opened[0]!.payload.form, "form_20"); assert.equal(h.rt.store.get("form_20_packages", "f20-cmp-5")!.data.status, "prepared");
  const t = h.timer("TX_50A6_CURE_60")[0]!; assert.equal(t.dueDate, "2026-11-09"); assert.equal(t.anchorDate, "2026-09-10");                                                              // 60 calendar days from the notice date
  await assert.rejects(h.run("4.5", "complaint.tx_50a6.escalate", CASE_AGENT, { case_id: "cmp-5", allegation: "again" }), refusedWith("TX_ALREADY_ESCALATED"));
  await assert.rejects(h.run("4.5", "complaint.tx_50a6.cure", CASE_AGENT, { case_id: "cmp-5", cure: "refund the excess fees with interest" }), refusedWith("HUMAN_ONLY"));               // the cure is a human act
  await assert.rejects(h.run("4.5", "complaint.tx_50a6.cure", ANALYST, { case_id: "cmp-5", cure: "refund the excess fees with interest" }), refusedWith("ROLE_DENIED"));
  await h.run("4.5", "complaint.tx_50a6.cure", ATTORNEY, { case_id: "cmp-5", cure: "refunding the fees that exceeded the 2% cap with interest" }, "2026-10-15T15:00:00.000Z");
  assert.equal(t.status, "satisfied"); assert.equal(h.events.ofType("complaint.tx_50a6.cured")[0]!.payload.form_20_logged, true); assert.equal(h.decisions.at(-1)!.approvedRole, "attorney");
  // a §50(a)(6) allegation on a loan not flagged, or a complaint without the allegation, arms nothing; the escalate command covers a later-detected allegation
  const h2 = harness("2026-09-10T15:00:00.000Z");
  await h2.run("4.5", "complaint.open", CASE_AGENT, { case_id: "cmp-5b", received_on: "2026-09-10", state: "TX", source: "borrower_direct", channel: "mail", text: "my escrow analysis is wrong" });
  assert.equal(h2.timer("TX_50A6_CURE_60").length, 0); assert.equal(h2.rt.escalations.opened.length, 0);
  await assert.rejects(h2.run("4.5", "complaint.tx_50a6.cure", ATTORNEY, { case_id: "cmp-5b", cure: "n/a" }), refusedWith("FORM_20_REQUIRED"));
  await h2.run("4.5", "complaint.tx_50a6.escalate", CASE_AGENT, { case_id: "cmp-5b", notice_on: "2026-09-12", allegation: "the follow-up letter alleges the §50(a)(6) fee cap was exceeded" });
  assert.equal(h2.timer("TX_50A6_CURE_60")[0]!.dueDate, "2026-11-11"); assert.equal(h2.rt.escalations.opened.length, 2);
  const v = notices().activeVersion("NTC_TX_50A6_CURE", D("2026-10-15"))!; const rr = render(v.source, v.samplePayload); assert.equal(evaluateChecklist(v, v.samplePayload, rr).passed, true);
});
test("4.5-T6: (population remediation) Given three complaints in a month about an undisclosed pay-by-phone fee, then the monitor opens a `udaap_review`, the lookback query identifies 1,240 loans, the remediation totals 1,860,000¢, `officer` approves, refunds post with reversal entries, letters mail, and the partner is notified.", async () => {
  const month = [D("2026-09-03"), D("2026-09-10"), D("2026-09-17")].map((received_on) => ({ fee_code: "pay_by_phone", channel: "phone", received_on }));
  const mon = CP.feeComplaintMonitor({ complaints: month, month: "2026-09", fee_code: "pay_by_phone", channel: "phone" });
  assert.deepEqual([mon.opens_udaap_review, mon.matching, mon.lookback_months], [true, 3, 24]); assert.match(mon.criteria, /fee_code = 'pay_by_phone' AND channel = 'phone' AND assessed_on >= now\(\) - interval '24 months'/);
  assert.equal(CP.feeComplaintMonitor({ complaints: month.slice(0, 2), month: "2026-09", fee_code: "pay_by_phone", channel: "phone" }).opens_udaap_review, false);
  const h = harness("2026-09-18T15:00:00.000Z");
  await h.run("4.5", "udaap_review.open", CASE_AGENT, { id: "udaap-1", monitor: "FEE_COMPLAINTS_PER_1000", criteria: mon.criteria });
  assert.equal(h.timer("SM_UDAAP_REVIEW_10BD")[0]!.dueDate, "2026-10-02");
  await assert.rejects(h.run("4.5", "udaap_review.close", CASE_AGENT, { id: "udaap-1", outcome: "finding", systemic: true }), refusedWith("UDAAP_ELEMENT_ANALYSIS"));
  await assert.rejects(h.run("4.5", "udaap_review.close", CASE_AGENT, { id: "udaap-9", outcome: "no_finding" }), refusedWith("REVIEW_NOT_FOUND"));
  const closed = (await h.run("4.5", "udaap_review.close", CASE_AGENT, { id: "udaap-1", outcome: "finding", systemic: true, analysis: CP.udaapScreen({ injury: true, avoidable: false, misleading_material: true, unreasonable_advantage: false }) }, "2026-09-25T15:00:00.000Z")).output as { remediation_due: string };
  assert.equal(closed.remediation_due, "2026-11-24"); assert.equal(h.timer("SM_UDAAP_REVIEW_10BD")[0]!.status, "satisfied"); assert.equal(h.timer("SM_POPULATION_REMEDIATION_60")[0]!.dueDate, "2026-11-24");   // 60 calendar days from the finding
  const loans = Array.from({ length: 1240 }, (_, n) => ({ loan_id: `L-${n + 1}`, assessed_on: "2026-06-15", fee_account: "other_fees" }));
  assert.equal(CP.populationRemediation(1240, 1_500n).total_cents, 1_860_000n);
  await assert.rejects(h.run("4.5", "population_remediation.execute", CASE_AGENT, { id: "pr-1", issue: "undisclosed pay-by-phone fee", loans, per_loan_cents: 1_500n }), refusedWith("POPULATION_REMEDIATION_OFFICER"));
  await assert.rejects(h.run("4.5", "population_remediation.execute", CASE_AGENT, { id: "pr-1", issue: "undisclosed pay-by-phone fee", loans, per_loan_cents: 1_500n, officer_approval_id: "appr-7" }), refusedWith("POPULATION_REMEDIATION_OFFICER"));   // not recorded by an officer
  await h.approve(OFFICER, { approval_id: "appr-7", case_id: "pr-1", scope: "population_remediation.execute", amount_cents: 1_860_000n, rationale: "1,240 loans × 1,500¢ pay-by-phone fee refund" });
  const r = (await h.run("4.5", "population_remediation.execute", CASE_AGENT, { id: "pr-1", issue: "undisclosed pay-by-phone fee", loans, per_loan_cents: 1_500n, officer_approval_id: "appr-7" })).output as { loans_affected: number; total_cents: bigint; entry_set_ids: string[]; letters: number };
  assert.deepEqual([r.loans_affected, r.total_cents, r.entry_set_ids.length, r.letters], [1240, 1_860_000n, 1240, 1240]);
  const sets = h.ctx.ledger.sets(); assert.equal(sets.length, 1240);
  assert.ok(sets.every((s) => s.effectiveDate === "2026-06-15" && s.lines.some((l) => l.account.scope === "loan" && l.account.account === "other_fees" && l.amountCents === -1_500n)));   // reversed with the original assessment date
  assert.equal(h.events.ofType("population_remediation.executed")[0]!.payload.total_cents, "1860000"); assert.deepEqual(h.events.ofType("population_remediation.executed")[0]!.payload.letters, { template: "NTC_REMEDIATION_REFUND", count: 1240 });
  assert.equal(h.events.ofType("partner.notified").length, 1); assert.equal(h.rt.store.get("population_remediations", "pr-1")!.data.approved_by, "appr-7");
  assert.equal(h.timer("SM_POPULATION_REMEDIATION_60")[0]!.status, "satisfied");
});
test("4.5-T7: (AI complaint) Given a chat transcript where the borrower asked for a human twice without transfer, then `AI_HUMAN_REQUEST_UNMET` fires, the case is `critical`, and the governance owner is notified the same day.", () => {
  const r = aiTranscriptMonitor([{ speaker: "borrower", text: "I want to speak to a person" }, { speaker: "ai", text: "I can help with that here." }, { speaker: "borrower", text: "No, get me a human" }, { speaker: "ai", text: "Let me look up your account." }], D("2026-09-10"));
  assert.deepEqual(r, { monitor: "AI_HUMAN_REQUEST_UNMET", severity: "critical", notify: { role: "ai_governance_owner", by: "2026-09-10" }, requests: 2 });
  assert.equal(aiTranscriptMonitor([{ speaker: "borrower", text: "I want a person" }, { speaker: "ai", text: "Transferring you now.", transferred: true }], D("2026-09-10")).monitor, null);
});
test("4.5-T8: (fair lending) Given a complaint alleging discrimination in a loss-mit denial, then `officer` review, 19.4 record, 12.3 appeal handling, no AI-only closure.", async () => {
  assert.deepEqual(fairLendingRouting({ alleges_discrimination: true, concerns_lossmit_denial: true }), { officer_review: true, fair_lending_record: "19.4", appeal: "12.3", ai_only_closure_allowed: false });
  assert.equal(fairLendingRouting({ alleges_discrimination: false, concerns_lossmit_denial: true }).ai_only_closure_allowed, true);
  const h = harness("2026-09-10T15:00:00.000Z");
  const o = (await h.run("4.5", "complaint.open", CASE_AGENT, { case_id: "cmp-8", received_on: "2026-09-10", source: "borrower_direct", channel: "mail", flags: ["fair_lending"], text: "you denied my modification because of my national origin" })).output as { officer_route: boolean; severity: string; linked_noe_case_id: string };
  assert.deepEqual([o.officer_route, o.severity, o.linked_noe_case_id], [true, "critical", "noe-cmp-8"]);                                                                              // a written denial dispute is also an NoE (comment 35(a)-2)
  await h.run("4.1", "case.noe.open", CASE_AGENT, { case_id: "noe-cmp-8", receipt_date: "2026-09-10", channel: "mail", linked_case_ids: ["cmp-8"], assertions: [{ id: "a1", category: "b11", description: "the modification denial was discriminatory" }] });
  await h.run("4.1", "case.noe.determine", CASE_AGENT, { case_id: "noe-cmp-8", assertion_id: "a1", determination: "no_error", snapshot_ids: ["snap-12-2"], statement_of_reasons: "the denial applied the investor's DTI criterion to the documented income; the 12.3 appeal is open", records_consulted: ["ledger", "notice_registry", "contact_logs"] });
  await h.run("4.1", "case.noe.respond", CASE_AGENT, { case_id: "noe-cmp-8", template: "NTC_REGX_35E_NO_ERROR" }, "2026-09-30T15:00:00.000Z");
  await assert.rejects(h.run("4.5", "complaint.close", CASE_AGENT, { case_id: "cmp-8", closed_with: "explanation", root_cause_code: "12.2 denial" }), refusedWith("OFFICER_ROUTE_FLAGS"));                              // no AI-only closure
  await assert.rejects(h.run("4.5", "complaint.close", CASE_AGENT, { case_id: "cmp-8", closed_with: "explanation", root_cause_code: "12.2 denial", officer_review_id: "rev-x" }), refusedWith("OFFICER_ROUTE_FLAGS"));   // no officer recorded that review
  await h.approve(OFFICER, { approval_id: "rev-8", case_id: "cmp-8", scope: "complaint.close", rationale: "19.4 fair-lending record made; 12.3 appeal opened; denial re-reviewed by the officer" });
  await h.run("4.5", "complaint.close", CASE_AGENT, { case_id: "cmp-8", closed_with: "explanation", root_cause_code: "12.2 denial", officer_review_id: "rev-8" });
  assert.equal(h.rt.store.get("cases", "cmp-8")!.data.officer_review_id, "rev-8"); assert.equal(h.events.ofType("case.approval.recorded")[0]!.actor.role, "officer");
  // the text alone routes to the officer even without an intake flag
  const h2 = harness("2026-09-10T15:00:00.000Z");
  await h2.run("4.5", "complaint.open", CASE_AGENT, { case_id: "cmp-8b", received_on: "2026-09-10", source: "borrower_direct", channel: "mail", text: "I was treated differently because I am a servicemember on active duty" });
  await assert.rejects(h2.run("4.5", "complaint.close", CASE_AGENT, { case_id: "cmp-8b", closed_with: "explanation", root_cause_code: "13.8" }), refusedWith("OFFICER_ROUTE_FLAGS"));
  await h2.run("4.5", "complaint.close", OFFICER, { case_id: "cmp-8b", closed_with: "explanation", root_cause_code: "13.8" });
});
test("4.5-T9: (wrong servicer) Given a state regulator complaint for a loan not on the platform, then a response within the state clock with no borrower data.", async () => {
  assert.deepEqual(wrongServicerResponse(D("2026-09-10"), 30), { response_by: "2026-10-10", content: "not_serviced_here_refer_to_correct_servicer", borrower_data_disclosed: false });
  // an investor referral (Fannie Mae escalation) is answered within the 5-Fannie-BD SLA (FNMA_REFERRAL_RESPONSE_5BD)
  const h = harness("2026-09-10T15:00:00.000Z");
  await assert.rejects(h.run("4.5", "investor.referral.respond", CASE_AGENT, { case_id: "cmp-9", response_text: "…" }), refusedWith("CASE_NOT_FOUND"));
  await h.run("4.5", "complaint.open", CASE_AGENT, { case_id: "cmp-9", received_on: "2026-09-10", source: "fannie_mae_referral", channel: "email", external_ref: "FNMA-ESC-1", text: "the borrower called 1-800-2FANNIE about a payoff quote" });
  assert.equal(h.events.ofType("investor.referral.received").length, 1); assert.equal(h.timer("FNMA_REFERRAL_RESPONSE_5BD")[0]!.dueDate, "2026-09-17");
  await h.run("4.5", "investor.referral.respond", CASE_AGENT, { case_id: "cmp-9", response_text: "quote corrected and re-issued on 2026-09-11" }, "2026-09-14T15:00:00.000Z");
  assert.equal(h.timer("FNMA_REFERRAL_RESPONSE_5BD")[0]!.status, "satisfied");
});
test("4.5-T10: (email SLA) Given an inbound email complaint at 09:00 ET Monday, then a substantive reply by 09:00 ET Wednesday (48h).", async () => {
  assert.equal(CP.emailReplyDeadlineMs(Date.parse("2026-09-14T13:00:00Z")), Date.parse("2026-09-16T13:00:00Z"));                      // Mon 2026-09-14 09:00 ET = 13:00Z (EDT); +48h = Wed 09:00 ET
  // the e-mail complaint enters through complaint.open, which ingests the inbound e-mail (communication.inbound.received{channel=email}) at its received_at
  const h = harness("2026-09-14T13:30:00.000Z");
  const o = (await h.run("4.5", "complaint.open", CASE_AGENT, { case_id: "cmp-10", received_on: "2026-09-14", received_at: "2026-09-14T13:00:00.000Z", source: "borrower_direct", channel: "email", from: "borrower@example.com", subject: "rude call", text: "your representative was rude and hung up on me twice" })).output as { email_reply_due_at: string };
  assert.equal(o.email_reply_due_at, "2026-09-16T13:00:00.000Z");
  const inbound = h.events.ofType("communication.inbound.received"); assert.equal(inbound.length, 1);
  assert.equal(inbound[0]!.payload.channel, "email"); assert.equal(inbound[0]!.payload.case_id, "cmp-10"); assert.equal(inbound[0]!.occurredAt, "2026-09-14T13:00:00.000Z");   // anchored on receipt, not on case opening
  const def = loadOverriddenRegistry().get("FNMA_A4_2_1_04_EMAIL_48H")!;
  const t = h.timer("FNMA_A4_2_1_04_EMAIL_48H")[0]!; assert.equal(t.armedByEventId, inbound[0]!.id); assert.equal(new Date(t.dueAt!).toISOString(), "2026-09-16T13:00:00.000Z");
  assert.ok(eventMatches(def.triggerPattern!, inbound[0]!));
  const emailBreaches = (at: string) => h.ctx.timers.evaluate(at).filter((b) => b.def.code === "FNMA_A4_2_1_04_EMAIL_48H").map((b) => b.def.code);
  // an e-mailed acknowledgment is an outbound e-mail with reply=false: it satisfies SM_COMPLAINT_ACK_1BD but not the 48-hour substantive-reply clock
  await h.run("4.5", "complaint.acknowledge", CASE_AGENT, { case_id: "cmp-10", channel: "email" }, "2026-09-14T15:00:00.000Z");
  const ack = h.events.ofType("communication.outbound.sent")[0]!; assert.deepEqual([ack.payload.channel, ack.payload.reply, ack.payload.kind, ack.payload.in_reply_to], ["email", false, "acknowledgment", inbound[0]!.id]);
  assert.equal(eventMatches(def.satisfiedPattern!, ack), false); assert.equal(t.status, "armed"); assert.equal(h.timer("SM_COMPLAINT_ACK_1BD")[0]!.status, "satisfied");
  assert.deepEqual(emailBreaches("2026-09-16T12:59:00.000Z"), []); assert.equal(t.status, "armed");                                              // still open one minute before the 48-hour mark
  // the substantive reply (complaint.respond on the e-mail case) is communication.outbound.sent{channel=email, reply=true} — sent Wed 08:00 ET, inside the window
  await h.run("4.5", "complaint.respond", CASE_AGENT, { case_id: "cmp-10", text: "What we found: the call was disconnected by our representative. What we fixed and when: coaching completed today; a callback is scheduled." }, "2026-09-16T12:00:00.000Z");
  const reply = h.events.ofType("communication.outbound.sent")[1]!; assert.deepEqual([reply.payload.channel, reply.payload.reply, reply.payload.kind, reply.payload.in_reply_to], ["email", true, "substantive_reply", inbound[0]!.id]);
  assert.ok(eventMatches(def.satisfiedPattern!, reply)); assert.equal(t.status, "satisfied"); assert.equal(t.satisfiedAt, "2026-09-16T12:00:00.000Z");
  assert.deepEqual(emailBreaches("2026-09-16T13:00:00.000Z"), []);                                                                              // answered inside the window: nothing breaches at 09:00 ET Wednesday
  // the ingestion handler validates the inbound record; an unanswered e-mail breaches at 48h; a mailed letter arms no e-mail clock
  assert.throws(() => receiveInboundEmail(h.events, { loan_id: "L-1", from: "not-an-address", received_at: "2026-09-14T13:00:00.000Z", text: "" }), /from must be an e-mail address; text required/);
  assert.deepEqual(validateInboundEmail({ loan_id: "L-1", from: "a@b.co", received_at: "2026-09-14T13:00:00.000Z", text: "hi" }), []);
  const h2 = harness("2026-09-14T13:00:00.000Z"); const e2 = receiveInboundEmail(h2.events, { loan_id: "L-1", from: "borrower@example.com", received_at: "2026-09-14T13:00:00.000Z", text: "where is my payoff quote?" });
  assert.equal(e2.payload.reply_due_at, "2026-09-16T13:00:00.000Z"); assert.deepEqual(h2.ctx.timers.evaluate("2026-09-16T12:59:00.000Z"), []);
  assert.deepEqual(h2.ctx.timers.evaluate("2026-09-16T13:00:00.000Z").map((b) => b.def.code), ["FNMA_A4_2_1_04_EMAIL_48H"]);
  const h3 = harness("2026-09-14T13:00:00.000Z"); await h3.run("4.5", "complaint.open", CASE_AGENT, { case_id: "cmp-10m", received_on: "2026-09-14", source: "borrower_direct", channel: "mail", text: "your representative was rude to me" });
  assert.equal(h3.events.ofType("communication.inbound.received").length, 0); assert.equal(h3.timer("FNMA_A4_2_1_04_EMAIL_48H").length, 0);
});
test("4.5-T11: (analytics) Given the monthly refresh, then complaints per 1,000 loans by category and by `preferred_language` are produced and monitor breaches create `officer` tasks.", () => {
  const a = complaintAnalytics([{ category: "fees", preferred_language: "en" }, { category: "fees", preferred_language: "es" }, { category: "escrow", preferred_language: "en" }], 1000, 1.5);
  assert.deepEqual(a.by_category, { fees: 2, escrow: 1 }); assert.deepEqual(a.by_language, { en: 2, es: 1 });
  assert.deepEqual(a.breaches, ["fees: 2 per 1,000 > 1.5"]); assert.equal(a.officer_tasks, 1);
});
test("4.5-T12: (monetary authority) Given an AI-proposed refund of 75,000¢, then the correction is blocked pending `officer` approval and the borrower is told the review timeline.", async () => {
  assert.equal(AI_MONETARY_LIMIT_CENTS, 50_000n);
  const r = monetaryAuthority(75_000n, { kind: "agent" });
  assert.equal(r.allowed, false); assert.equal(r.requires, "officer"); assert.match(r.borrower_message!, /under review by an officer/);
  assert.equal(monetaryAuthority(45_000n, { kind: "agent" }).allowed, true); assert.equal(monetaryAuthority(75_000n, { kind: "human", role: "officer" }).allowed, true);
  const h = harness("2026-09-10T15:00:00.000Z");
  await h.run("4.5", "complaint.open", CASE_AGENT, { case_id: "cmp-12", received_on: "2026-09-10", source: "borrower_direct", channel: "mail", text: "you charged me $750 in fees you never disclosed" });
  await assert.rejects(h.run("4.5", "complaint.remediate", CASE_AGENT, { case_id: "cmp-12", fee_account: "other_fees", amount_cents: 75_000n, assessed_on: "2026-06-15", reason: "undisclosed fees" }), refusedWith("MONETARY_AUTHORITY_50000"));     // blocked pending officer approval
  await assert.rejects(h.run("4.5", "complaint.remediate", CASE_AGENT, { case_id: "cmp-12", fee_account: "other_fees", amount_cents: 75_000n, assessed_on: "2026-06-15", officer_approval_id: "x" }), refusedWith("MONETARY_AUTHORITY_50000"));    // no officer recorded "x"
  assert.equal(h.ctx.ledger.sets().length, 0); assert.deepEqual(h.events.ofType("command.refused").map((e) => e.payload.code), ["MONETARY_AUTHORITY_50000", "MONETARY_AUTHORITY_50000"]);
  await h.run("4.5", "complaint.remediate", CASE_AGENT, { case_id: "cmp-12", fee_account: "other_fees", amount_cents: 45_000n, assessed_on: "2026-06-15", reason: "within authority" });                                                        // ≤ 50,000¢ posts without approval
  await h.approve(OFFICER, { approval_id: "appr-12", case_id: "cmp-12", scope: "complaint.remediate", amount_cents: 75_000n, rationale: "undisclosed fee schedule confirmed" });
  await assert.rejects(h.run("4.5", "complaint.remediate", CASE_AGENT, { case_id: "cmp-12", fee_account: "other_fees", amount_cents: 90_000n, assessed_on: "2026-06-15", officer_approval_id: "appr-12" }), refusedWith("MONETARY_AUTHORITY_50000"));   // approval covers 75,000¢ only
  const rem = (await h.run("4.5", "complaint.remediate", CASE_AGENT, { case_id: "cmp-12", fee_account: "other_fees", amount_cents: 75_000n, assessed_on: "2026-06-15", reason: "undisclosed fees", officer_approval_id: "appr-12" })).output as { amount_cents: bigint; closed_with: string };
  assert.deepEqual([rem.amount_cents, rem.closed_with], [75_000n, "monetary_relief"]); assert.equal(h.ctx.ledger.balance({ scope: "loan", loanId: "L-1", account: "other_fees" }), -120_000n);
});
