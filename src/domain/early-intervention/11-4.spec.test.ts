// 11.4 FDCPA compliance
// spec/sections/11-early-intervention-collections/11-4-fdcpa-compliance.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { itemizationChecks } from "./fdcpa.ts";
import { disputeLifecycle, dcLoanEiNotice, writtenCease, oralCease, attorneyGate, furnishingGate, smsRndGate, dcEmailCheck, voicemailCheck, deceasedReport, assumedNameCheck, stateOverlay } from "./ops.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";

// 11.4-T1 — implemented in src/domain/early-intervention/early-intervention.test.ts
// 11.4-T2 — implemented in src/domain/early-intervention/early-intervention.test.ts
// 11.4-T3 — implemented in src/domain/early-intervention/early-intervention.test.ts
test("11.4-T4: Given the B-1 mortgage variant, then the itemization lines sum: 31,254,022 + 123,811 + 16,500 \u2212 0 \u2212 0 = 31,394,333 cents = $313,943.33 and the checklist passes; given the (c)(5) substitute, then the latest statement is attached and referenced.", () => {
  const it = itemizationChecks({ itemization_date: D("2026-08-17"), amount_on_itemization_cents: 31254022n, interest_since_cents: 123811n, fees_since_cents: 16500n, payments_since_cents: 0n, credits_since_cents: 0n, current_amount_cents: 31394333n });
  assert.equal(it.sum_cents, 31394333n); assert.equal(it.consistent, true);
  const reg = buildRegistry(); publishAuthored(reg);
  const v = reg.activeVersion("NTC_REGF_1006_34_VALIDATION_B1", D("2026-10-02"))!;
  const rendered = render(v.source, v.samplePayload); assert.ok(rendered.text.includes("$313,943.33")); assert.equal(evaluateChecklist(v, v.samplePayload, rendered).passed, true);
  const sub = { ...v.samplePayload, statement_substitute: true, statement_date: "2026-09-17" };
  const r2 = render(v.source, sub); assert.ok(r2.text.includes("See the enclosed periodic statement dated September 17, 2026")); assert.equal(evaluateChecklist(v, sub, r2).passed, true);
});
test("11.4-T5: Given a written dispute received 2026-10-20, then `collection_ceased_at` is set, an outbound collection call on 10-21 is refused, statements still generate, and after verification mails 2026-11-05 collection resumes.", () => {
  const r = disputeLifecycle({ received_on: D("2026-10-20"), verification_mailed_on: D("2026-11-05") });
  assert.equal(r.collection_ceased_at, D("2026-10-20")); assert.equal(r.callAllowed(D("2026-10-21")).allowed, false); assert.equal(r.statements_allowed, true);
  assert.equal(r.collection_resumed_at, D("2026-11-05")); assert.equal(r.callAllowed(D("2026-11-05")).allowed, true);
});
test("11.4-T6: Given an EI notice due during the validation period, then the template check refuses a version demanding payment \"within 10 days\" and accepts the standard MS-4 version with the \u00a71006.18(e) fragment.", () => {
  const bad = dcLoanEiNotice({ text: "This communication is from a debt collector. You must pay within 10 days. You may dispute this debt.", validation_end: D("2026-11-08"), ref_date: D("2026-10-20"), in_validation_period: true });
  assert.equal(bad.accepted, false); assert.ok(bad.overshadow_issues.some((s) => /within 10 days/.test(s)));
  const reg = buildRegistry(); publishAuthored(reg);
  const v = reg.activeVersion("NTC_REGX_39D_EARLY_INTERVENTION_FDCPA", D("2026-12-14"))!;
  const ok = dcLoanEiNotice({ text: render(v.source, v.samplePayload).text, validation_end: D("2026-11-08"), ref_date: D("2026-10-20"), in_validation_period: true });
  assert.equal(ok.accepted, true); assert.equal(ok.fragment_present, true);
});
test("11.4-T7: Given a written cease from the borrower on a DC loan, then 11.1's plan is `suspended{cease_request}`, the 11.2 variant switches to `fdcpa` (190-day cycle), the cease acknowledgement is sent once, and a borrower-initiated call about a modification is answered fully.", () => {
  const r = writtenCease({ received_on: D("2026-11-10"), ack_sent_before: false });
  assert.equal(r.plan, "suspended{cease_request}"); assert.equal(r.ei_variant, "fdcpa"); assert.equal(r.cycle_days, 190); assert.equal(r.send_ack, true); assert.equal(r.borrower_initiated_lossmit_call, "answered_fully");
  assert.equal(writtenCease({ received_on: D("2026-11-10"), ack_sent_before: true }).send_ack, false);
});
test("11.4-T8: Given an oral \"stop calling me,\" then voice/SMS/email stop within 1 minute, mail continues, the EI variant stays standard, and the transcript shows the written-request explanation.", () => {
  const r = oralCease({ at_ms: 1_700_000_000_000 });
  assert.deepEqual([...r.stopped], ["voice", "sms", "email"]); assert.equal(r.stopped_by_ms, 1_700_000_060_000); assert.equal(r.mail_continues, true); assert.equal(r.ei_variant, "standard");
  assert.match(r.transcript_explanation, /in writing/);
});
test("11.4-T9: Given an attorney letter of representation, then direct communications are refused, counsel receives the communications, and after 30 days of documented non-response direct contact re-opens with a decision record.", () => {
  const early = attorneyGate({ designated_on: D("2026-10-05"), counsel_contacted_on: D("2026-10-06"), counsel_responded: false, today: D("2026-10-20") });
  assert.equal(early.direct_allowed, false); assert.equal(early.route, "counsel"); assert.equal(early.reopen_on, D("2026-11-05")); assert.equal(early.decision_record, null);
  const late = attorneyGate({ designated_on: D("2026-10-05"), counsel_contacted_on: D("2026-10-06"), counsel_responded: false, today: D("2026-11-05") });
  assert.equal(late.direct_allowed, true); assert.equal(late.decision_record!.action, "direct_contact_reopened");
  assert.equal(attorneyGate({ designated_on: D("2026-10-05"), counsel_contacted_on: D("2026-10-06"), counsel_responded: true, today: D("2026-12-05") }).direct_allowed, false);
});
test("11.4-T10: Given the validation notice mailed 2026-10-02 with no undeliverability notice by 2026-10-16, then `furnishing_gate_open_at`=2026-10-16 and 8.x may furnish; given a conversation on 2026-10-05, then the gate opens 2026-10-05.", () => {
  assert.deepEqual(furnishingGate({ mailed_on: D("2026-10-02") }), { furnishing_gate_open_at: D("2026-10-16"), basis: "14 days after mailing with no undeliverability notice" });
  assert.equal(furnishingGate({ mailed_on: D("2026-10-02"), conversation_on: D("2026-10-05") }).furnishing_gate_open_at, D("2026-10-05"));
  assert.equal(furnishingGate({ mailed_on: D("2026-10-02"), undeliverable_on: D("2026-10-10") }).furnishing_gate_open_at, null);
});
test("11.4-T11: Given an SMS to a consented number last RND-checked 70 days ago and no inbound text in 60 days, then the send is refused until a fresh RND check.", () => {
  assert.deepEqual(smsRndGate({ days_since_rnd_check: 70, days_since_consumer_texted: 61 }), { allowed: false, refused_by: "REGF_1006_6D5_SMS_RND_60" });
  assert.equal(smsRndGate({ days_since_rnd_check: 10, days_since_consumer_texted: null }).allowed, true);
  assert.equal(smsRndGate({ days_since_rnd_check: null, days_since_consumer_texted: 30 }).allowed, true);
});
test("11.4-T12: Given any DC-loan email, then the opt-out statement is present and the subject line contains no debt reference (automated check, 100 %).", () => {
  const ok = dcEmailCheck({ subject: "A message from Supermortgage", body: "... This communication is from a debt collector. To opt out of email, reply with the word unsubscribe." });
  assert.equal(ok.compliant, true);
  assert.equal(dcEmailCheck({ subject: "Your past due mortgage payment", body: "opt out" }).subject_clean, false);
  assert.equal(dcEmailCheck({ subject: "Hello", body: "no way out" }).opt_out_present, false);
});
test("11.4-T13: Given a voicemail on a DC loan, then only the LCM template is used (business name, request to reply, agent name, number); a message mentioning \"your mortgage payment\" is refused.", () => {
  const base = { business_name: "Supermortgage", agent_name: "Ava", phone: "(800) 555-0199" };
  const ok = voicemailCheck({ ...base, text: "This is Ava from Supermortgage. Please call me back at (800) 555-0199. You may speak with any representative." });
  assert.equal(ok.allowed, true); assert.equal(ok.template, "limited_content");
  const bad = voicemailCheck({ ...base, text: "This is Ava from Supermortgage about your mortgage payment. Please call me back at (800) 555-0199." });
  assert.equal(bad.allowed, false); assert.ok(bad.violations.includes("mentions the debt"));
});
test("11.4-T14: Given a deceased borrower reported by a neighbor, then no debt information is disclosed, location information for the estate may be requested, and communications wait for an executor/successor (4.4).", () => {
  const r = deceasedReport({ reporter_relation: "neighbor" });
  assert.equal(r.disclose_debt, false); assert.equal(r.may_request_location_info, true); assert.equal(r.wait_for, "executor_or_successor"); assert.equal(r.route, "4.4"); assert.equal(r.reporter_is_consumer, false);
  assert.equal(deceasedReport({ reporter_relation: "executor" }).reporter_is_consumer, true);
});
test("11.4-T15: Given the AI persona \"Ava,\" then the assumed name is in the registry and every DC-loan call transcript shows \"Ava with Supermortgage\u2026 this communication is from a debt collector.\"", () => {
  const r = assumedNameCheck({ persona: "Ava", registry: ["Ava", "Sam"], transcript: "Hi, this is Ava with Supermortgage. This communication is from a debt collector." });
  assert.equal(r.compliant, true); assert.equal(r.registered, true);
  assert.equal(assumedNameCheck({ persona: "Zed", registry: ["Ava"], transcript: "Zed with Supermortgage. This communication is from a debt collector." }).compliant, false);
  assert.equal(assumedNameCheck({ persona: "Ava", registry: ["Ava"], transcript: "Ava with Supermortgage. How are you?" }).disclosure_present, false);
});
test("11.4-T16: Given a CA loan boarded current, then Reg F is not applicable but the Rosenthal overlay enforces quiet hours and harassment rules in the Contact Engine.", () => {
  const r = stateOverlay({ state: "CA", debt_collector: false });
  assert.equal(r.regf_applicable, false); assert.deepEqual([...r.overlays], ["rosenthal_ca"]); assert.equal(r.contact_engine.quiet_hours, true); assert.equal(r.contact_engine.harassment_rules, true);
  assert.equal(stateOverlay({ state: "TX", debt_collector: false }).contact_engine.harassment_rules, false);
  assert.equal(stateOverlay({ state: "MA", debt_collector: false }).contact_engine.call_cap_7d, 2);
});
