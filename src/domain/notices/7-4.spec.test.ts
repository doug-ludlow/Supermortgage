// 7.4 E-SIGN consent for e-delivery
// spec/sections/07-compliance-notices-disclosures/7-4-e-sign-consent-for-e-delivery.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { MemoryEventStore, FixedClock, SYSTEM, eventMatches } from "../../kernel/events/index.ts";
import { TimerEngine } from "../../kernel/timers/engine.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";
import { decideChannel } from "../../notices/channel.ts";
import { NoticeService } from "../../notices/service.ts";
import { FakePrintMail, FakeEdelivery } from "../../infra/integrations/delivery.ts";
import { newConsent, verify, withdraw, channelFor, irs1098Channel, tcpaConsentFromCall, type Consent } from "./esign.ts";
import { tcpaStop, transferInEstatementFlag, consentExamRecord, voiceEnrollmentRequest, availabilityEmailBounce } from "./ops.ts";
import { captureConsent, completeVerification, expireVerification, decideNoticeChannel, requestForm1098Furnish, announceHwSwChange, completeReconsent, receiveWithdrawal, applyWithdrawal, receiveTcpaRevocation, applyTcpaRevocation, recordPortalView, revalidationCheck, voiceEnrollment } from "./ops-7-4.ts";

const rig = (iso: string) => { const clock = new FixedClock(iso); const events = new MemoryEventStore(clock); const engine = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["7.4"] }); return { clock, events, engine }; };
const active = (party: string, classes: string[]): Consent => { const c = newConsent(party, classes, "v1.3", D("2026-10-02"), "portal"); if ("error" in c) throw new Error(c.error); return verify(c, true, true, D("2026-10-02")); };
const published = () => { const reg = buildRegistry(); publishAuthored(reg); return reg; };
const EVIDENCE = { ip: "203.0.113.7", user_agent: "Mozilla/5.0" } as const;
const CLICK = "2026-10-02T14:14:00.000Z";   // worked example: Oct 2, 2026 10:14 ET — disclosure v1.3 shown, consent clicked, verification email sent

test("7.4-T1: Given a borrower views disclosure v1.3 and clicks consent, when the verification link is opened and the PDF token entered within 7 days, then the consent row is `active` with both evidence items; without the token, it stays `pending_verification` and no electronic notice is sent.", () => {
  const { clock, events, engine } = rig(CLICK); const deps = { events };
  const cap = captureConsent(deps, { loan_id: "L-1", party_id: "A", consent_id: "consent-A-1", classes: ["periodic_statements"], disclosure_version: "v1.3", disclosure_hash: "sha256:7f3a", clicked_at: CLICK, captured_via: "portal", ...EVIDENCE });
  const c = cap.consent;
  assert.equal(c.status, "pending_verification"); assert.equal(c.disclosure_version, "v1.3"); assert.equal(cap.expires_on, "2026-10-09"); assert.equal(cap.verification_email, "NTC_ESIGN_VERIFICATION_EMAIL");
  assert.deepEqual(cap.events.map((e) => e.type), ["consent.esign.disclosed", "consent.esign.pending"]); assert.equal((cap.events[0]!.payload as { disclosure_hash: string }).disclosure_hash, "sha256:7f3a");
  const t = engine.byCode("SM_ESIGN_VERIFY_EXPIRY_7")[0]!;                                                                  // armed by the click: +7 calendar days
  assert.equal(t.status, "armed"); assert.equal(t.anchorDate, "2026-10-02"); assert.equal(t.dueDate, "2026-10-09");
  // link opened from the email, no token → still pending_verification, nothing appended, no electronic notice
  const half = completeVerification(deps, { loan_id: "L-1", consent_id: "consent-A-1", consent: c, link_opened_at: "2026-10-02T14:20:00.000Z", token_entered_at: null, token_ok: false, ...EVIDENCE });
  assert.equal(half.verified, false); assert.match(half.reason!, /PDF token not entered/); assert.equal(c.status, "pending_verification"); assert.deepEqual(half.events, []); assert.equal(t.status, "armed");
  const reg = buildRegistry(); const stmt = reg.template("NTC_REGZ_41_STMT_STD");
  const A = { partyId: "A", name: "A", mailingAddress: "1 Test St", email: "a@x.com", consent: c };
  assert.equal(decideChannel(stmt, [A])[0]!.channel, "mail_first_class");
  const pendingDecision = decideNoticeChannel(deps, { loan_id: "L-1", notice_id: "N-0", template: "NTC_REGZ_41_STMT_STD", notice_class: "periodic_statements", recipients: [{ party_id: "A", consent: c }] });
  assert.equal(pendingDecision.gate_open, false); assert.deepEqual(pendingDecision.channels.map((x) => x.channel), ["mail"]); assert.equal(pendingDecision.fallback, "mail");
  // day 7 (Oct 9) is still inside the window: link + token → active with both evidence items; the verified event closes the clock
  clock.set("2026-10-09T14:21:00.000Z");
  const done = completeVerification(deps, { loan_id: "L-1", consent_id: "consent-A-1", consent: c, link_opened_at: "2026-10-09T14:20:00.000Z", token_entered_at: "2026-10-09T14:21:00.000Z", token_ok: true, ...EVIDENCE });
  assert.equal(done.verified, true); assert.equal(c.status, "active"); assert.equal(c.verified_on, "2026-10-09"); assert.deepEqual(done.events.map((e) => e.type), ["consent.esign.verified", "consent.esign.active"]);
  assert.equal(t.status, "satisfied"); assert.equal(t.satisfiedByEventId, done.events[0]!.id);
  const verified = events.ofType("consent.esign.verified")[0]!.payload as { link_opened_at: string; token_entered_at: string; token_ok: boolean; ip: string };
  assert.deepEqual([verified.link_opened_at, verified.token_entered_at, verified.token_ok, verified.ip], ["2026-10-09T14:20:00.000Z", "2026-10-09T14:21:00.000Z", true, "203.0.113.7"]);   // both evidence items
  assert.equal((events.ofType("consent.esign.active")[0]!.payload as { verified_at: string }).verified_at, "2026-10-09T14:21:00.000Z");
  assert.equal(decideChannel(stmt, [A])[0]!.channel, "email_link");
  const exam = consentExamRecord(c, { disclosure_version: "v1.3", disclosure_hash: "sha256:7f3a", consented_at: CLICK, verification_link_opened_at: "2026-10-09T14:20:00.000Z", token_entered_at: "2026-10-09T14:21:00.000Z", ip: "203.0.113.7", user_agent: "Mozilla/5.0", token_ok: true });
  assert.equal(exam.reproducible, true); assert.deepEqual(exam.fields.verification, { link_opened_at: "2026-10-09T14:20:00.000Z", token_entered_at: "2026-10-09T14:21:00.000Z", token_ok: true });
  // day 8: outside the window → refused, the clock breaches → status `expired`; re-invite
  const late = captureConsent(deps, { loan_id: "L-1", party_id: "B", consent_id: "consent-B-1", classes: ["periodic_statements"], disclosure_version: "v1.3", disclosure_hash: "sha256:7f3a", clicked_at: CLICK, captured_via: "portal", ...EVIDENCE });
  const tb = engine.byCode("SM_ESIGN_VERIFY_EXPIRY_7")[1]!; assert.equal(tb.dueDate, "2026-10-09");
  clock.set("2026-10-10T14:21:00.000Z");
  const lateV = completeVerification(deps, { loan_id: "L-1", consent_id: "consent-B-1", consent: late.consent, link_opened_at: "2026-10-10T14:20:00.000Z", token_entered_at: "2026-10-10T14:21:00.000Z", token_ok: true, ...EVIDENCE });
  assert.equal(lateV.verified, false); assert.match(lateV.reason!, /8 days after the click — outside the 7-day window/); assert.equal(late.consent.status, "pending_verification");
  assert.deepEqual(engine.evaluate("2026-10-10T04:00:00.000Z").map((b) => [b.instance.code, b.instance.id]), [["SM_ESIGN_VERIFY_EXPIRY_7", tb.id]]);   // 00:00 ET Oct 10: past end of day Oct 9
  const ex = expireVerification(deps, { loan_id: "L-1", consent_id: "consent-B-1", consent: late.consent, on: D("2026-10-10") });
  assert.equal(ex.status, "expired"); assert.equal(late.consent.status, "expired"); assert.equal(ex.reinvite, "NTC_ESIGN_VERIFICATION_EMAIL"); assert.equal(ex.event!.type, "consent.esign.expired");
  assert.throws(() => captureConsent(deps, { loan_id: "L-1", party_id: "C", consent_id: "consent-C-1", classes: [], disclosure_version: "v1.3", disclosure_hash: "sha256:7f3a", clicked_at: CLICK, captured_via: "portal", ...EVIDENCE }), RangeError);
  assert.throws(() => captureConsent(deps, { loan_id: "L-1", party_id: "C", consent_id: "consent-C-1", classes: ["tax_statements"], disclosure_version: "v1.3", disclosure_hash: "sha256:7f3a", clicked_at: CLICK, captured_via: "portal", ...EVIDENCE }), /irs_estatement/);
});
test('7.4-T2: Given an AI voice call in which the borrower says "yes, email me my statements," then no E-SIGN consent is created; an invitation email/SMS (with `tcpa_sms` consent) is sent and the call is logged with the automation disclosure.', () => {
  const r = voiceEnrollmentRequest({ party_id: "A", channel: "ai_voice", utterance: "yes, email me my statements", email: "a@x.com", mobile: "+15125550123", tcpa_sms_consent: true, call_id: "call-1", on: D("2026-10-02") });
  assert.equal(r.esign_consent, null); assert.match(r.refusal, /7001\(c\)\(6\)/);
  assert.deepEqual(r.invitation, { email: true, sms: true, link: "NTC_ESIGN_VERIFICATION_EMAIL" });
  assert.deepEqual(r.call_log, { call_id: "call-1", automation_disclosure: true, disclosure_event: "consent.ai_disclosure.acknowledged", utterance: "yes, email me my statements", logged_on: "2026-10-02" });
  assert.equal(voiceEnrollmentRequest({ party_id: "A", channel: "ai_voice", utterance: "yes", email: "a@x.com", mobile: "+15125550123", tcpa_sms_consent: false, call_id: "call-2", on: D("2026-10-02") }).invitation.sms, false);   // no SMS without tcpa_sms
  assert.ok("error" in newConsent("A", ["periodic_statements"], "v1.3", D("2026-10-02"), "voice"));
  // through the consent service: the call logs the automation disclosure and the invitation; no consent row, no pending/active event, no verification clock
  const { events, engine } = rig("2026-10-02T15:00:00.000Z");
  const v = voiceEnrollment({ events }, { loan_id: "L-1", party_id: "A", channel: "ai_voice", utterance: "yes, email me my statements", email: "a@x.com", mobile: "+15125550123", tcpa_sms_consent: true, call_id: "call-1", on: D("2026-10-02") });
  assert.deepEqual(v.events.map((e) => e.type), ["consent.ai_disclosure.acknowledged", "consent.esign.invited"]);
  assert.deepEqual(v.events[1]!.payload, { party_id: "A", email: true, sms: true, link: "NTC_ESIGN_VERIFICATION_EMAIL", esign_consent_created: false, refusal: r.refusal });
  assert.equal(events.ofType("consent.esign.pending").length + events.ofType("consent.esign.active").length, 0); assert.equal(engine.all().length, 0);
  // the TCPA guardrail: a consent from a call needs the scripted language, the confirmed number and the recording id
  assert.match(tcpaConsentFromCall({ kind: "tcpa_sms", number: "+15125550123", scripted_language_present: false, number_confirmed: true, recording_id: "REC-1", on: D("2026-10-02") }).refusal!, /scripted consent language/);
  assert.equal(tcpaConsentFromCall({ kind: "tcpa_sms", number: "+15125550123", scripted_language_present: true, number_confirmed: true, recording_id: "REC-1", on: D("2026-10-02") }).consent!.evidence.recording_id, "REC-1");
});
test("7.4-T3: Given only the primary borrower has active consent, then the statement is posted/emailed to the primary and mailed to the co-borrower, and the timer is satisfied by the mail delivery.", async () => {
  const c = active("A", ["periodic_statements"]);
  assert.deepEqual(channelFor([{ party_id: "A", consent: c }, { party_id: "B" }], "periodic_statements"), [{ party_id: "A", channel: "electronic" }, { party_id: "B", channel: "mail" }]);
  const reg = published(); const { clock, events, engine } = rig("2026-10-17T14:05:00.000Z");
  const svc = new NoticeService({ registry: reg, events, clock, printMail: new FakePrintMail(), edelivery: new FakeEdelivery() });
  const A = { partyId: "A", name: "A", mailingAddress: "1 Test St", email: "a@x.com", consent: c, portalUser: true }; const B = { partyId: "B", name: "B", mailingAddress: "1 Test St" };
  const v = reg.activeVersion("NTC_REGZ_41_STMT_DELQ", D("2026-10-17"))!;
  const n = svc.render({ templateCode: "NTC_REGZ_41_STMT_DELQ", loanId: "L-1", recipients: [A, B], payload: v.samplePayload, asOf: D("2026-10-17") });
  // the channel decision requests electronic; ESIGN_7001C_CONSENT_GATE arms on it and its evaluator closes for B → B mails, A's portal copy does not satisfy the timer
  const d = decideNoticeChannel({ events }, { loan_id: "L-1", notice_id: n.id, template: "NTC_REGZ_41_STMT_DELQ", notice_class: "periodic_statements", recipients: [{ party_id: "A", consent: c }, { party_id: "B" }] });
  assert.equal(d.requested_channel, "electronic"); assert.equal(d.gate_open, false); assert.equal(d.gate_reason, "no active E-SIGN consent covering the class for B"); assert.equal(d.fallback, "mail");
  assert.deepEqual(d.channels.map((x) => [x.party_id, x.channel, x.satisfies_timer]), [["A", "electronic", false], ["B", "mail", true]]);
  const gate = engine.byCode("ESIGN_7001C_CONSENT_GATE")[0]!; assert.equal(gate.status, "armed"); assert.equal(gate.note, "evaluator:7.4.esignConsentActiveForEveryRecipient"); assert.equal(gate.dueDate, undefined); assert.equal(gate.armedByEventId, d.event.id);
  await svc.send(n.id, { preferPortal: true });
  assert.deepEqual(n.deliveries.map((x) => [x.partyId, x.channel, x.satisfiesTimer]), [["A", "portal_post", false], ["B", "mail_first_class", true]]);
  const sent = events.ofType("notice.sent")[0]!.payload as { channels: { party_id: string; channel: string; satisfies_timer: boolean }[] };
  assert.deepEqual(sent.channels, [{ party_id: "A", channel: "portal_post", satisfies_timer: false }, { party_id: "B", channel: "mail_first_class", satisfies_timer: true }]);
  // both parties consented → the gate opens and each electronic delivery satisfies the timer; a mail_only template never requests electronic (no gate)
  const both = decideNoticeChannel({ events }, { loan_id: "L-1", notice_id: "N-2", template: "NTC_REGZ_41_STMT_DELQ", notice_class: "periodic_statements", recipients: [{ party_id: "A", consent: c }, { party_id: "B", consent: active("B", ["periodic_statements"]) }] });
  assert.equal(both.gate_open, true); assert.deepEqual(both.channels.map((x) => [x.channel, x.satisfies_timer]), [["electronic", true], ["electronic", true]]);
  const mailOnly = decideNoticeChannel({ events }, { loan_id: "L-1", notice_id: "N-3", template: "NTC_ESIGN_WITHDRAWAL_CONFIRMATION", notice_class: "general_correspondence", recipients: [{ party_id: "A", consent: c }], template_mail_only: true });
  assert.equal(mailOnly.requested_channel, "mail"); assert.equal(engine.byCode("ESIGN_7001C_CONSENT_GATE").length, 2);
  assert.throws(() => decideNoticeChannel({ events }, { loan_id: "L-1", notice_id: "N-4", template: "NTC_REGZ_41_STMT_DELQ", notice_class: "periodic_statements", recipients: [] }), RangeError);
});
test("7.4-T4: Given a hard bounce on a statement notification Dec 3, then a paper statement is mailed by Dec 4, consent = `suspect`, and a re-verification invitation is issued.", async () => {
  const c = active("A", ["periodic_statements"]);
  const { clock, events, engine } = rig("2026-12-03T15:00:00.000Z");
  const reg = published(); const pm = new FakePrintMail(); const ed = new FakeEdelivery(); ed.bouncing.add("a@x.com");
  const svc = new NoticeService({ registry: reg, events, clock, printMail: pm, edelivery: ed });
  const A = { partyId: "A", name: "A", mailingAddress: "1 Test St", email: "a@x.com", consent: c };
  const v = reg.activeVersion("NTC_REGZ_41_STMT_DELQ", D("2026-12-03"))!;
  const n = svc.render({ templateCode: "NTC_REGZ_41_STMT_DELQ", loanId: "L-1", recipients: [A], payload: v.samplePayload, asOf: D("2026-12-03") });
  await svc.send(n.id);
  assert.deepEqual(n.deliveries.map((d) => [d.channel, d.emailStatus ?? null, d.fallbackOf ?? null, d.satisfiesTimer]), [["email_link", "bounced", null, true], ["mail_first_class", null, 1, true]]);
  assert.equal(c.status, "suspect");
  const t = engine.byCode("SM_EMAIL_BOUNCE_SUSPECT_1BD")[0]!; assert.equal(t.dueDate, "2026-12-04"); assert.equal(t.status, "armed");   // armed by notice.bounced{reason=hard bounce}
  clock.set("2026-12-04T13:00:00.000Z"); pm.runProduction("2026-12-04T13:00:00.000Z");
  const job = pm.jobs.get(`${n.id}:2`)!; svc.recordMailed(n.id, 2, job.mailedAt!, job.proofOfMailingId!);
  assert.equal(t.status, "satisfied"); assert.equal((events.ofType("notice.mailed")[0]!.payload as { mailed_at: string }).mailed_at, "2026-12-04T13:00:00.000Z");
  const b = availabilityEmailBounce({ consent: active("C", ["periodic_statements"]), bounced_on: D("2026-12-03"), kind: "hard" });
  assert.equal(b.mail_paper_by, "2026-12-04"); assert.equal(b.consent_status, "suspect"); assert.equal(b.reverification_invite, true);
  const bounceNotice = reg.activeVersion("NTC_EDELIVERY_BOUNCE_PAPER_RESUME", D("2026-12-04"))!;                          // the re-verification invitation rides with the paper copy
  assert.match(render(bounceNotice.source, bounceNotice.samplePayload).text, /confirm your email address in the portal/); assert.equal(reg.template("NTC_EDELIVERY_BOUNCE_PAPER_RESUME").channelPolicy, "mail_only");
  // Jan 12, 2027 (worked example): the address is updated and the demonstration completed again → a new active row, `reconsent_of` the prior
  const again = completeReconsent({ events }, { loan_id: "L-1", prior: c, prior_id: "consent-A-1", consent_id: "consent-A-2", link_opened_at: "2027-01-12T15:00:00.000Z", token_entered_at: "2027-01-12T15:02:00.000Z", token_ok: true });
  assert.equal(again.consent!.status, "active"); assert.equal(again.consent!.reconsent_of, "consent-A-1"); assert.equal(again.consent!.verified_on, "2027-01-12"); assert.equal(c.status, "suspect");
});
test("7.4-T5: Given the portal drops support for an old PDF viewer (material change) effective Feb 1, then all E-SIGN consents show `reconsent_required`, `NTC_ESIGN_HWSW_CHANGE_RECONSENT` is sent, and electronic delivery is blocked until re-demonstration.", () => {
  const a = active("A", ["periodic_statements"]); const b = active("B", ["arm_notices"]);
  const { events, engine } = rig("2027-01-15T15:00:00.000Z"); const deps = { events };
  const change = announceHwSwChange(deps, { loan_id: "L-1", consents: [a, b], effective_on: D("2027-02-01"), change: "PDF viewer < 9 no longer supported", material: true, determined_by: "officer", hw_sw_version: "hwsw-2027.02" });
  assert.deepEqual(change.flagged, ["A", "B"]); assert.equal(a.status, "reconsent_required"); assert.equal(b.status, "reconsent_required");
  assert.equal(change.notice, "NTC_ESIGN_HWSW_CHANGE_RECONSENT"); assert.equal(change.electronic_blocked, true);
  assert.deepEqual(change.events.map((e) => e.type), ["hw_sw_requirements.changed", "consent.esign.reconsent_required", "consent.esign.reconsent_required"]);
  assert.deepEqual(change.events[0]!.payload, { material: true, effective_on: "2027-02-01", change: "PDF viewer < 9 no longer supported", hw_sw_version: "hwsw-2027.02", determined_by: "officer", flagged: ["A", "B"], notice: "NTC_ESIGN_HWSW_CHANGE_RECONSENT", electronic_blocked: true });
  const reg = published(); const hw = reg.activeVersion("NTC_ESIGN_HWSW_CHANGE_RECONSENT", D("2027-01-15"))!;
  assert.equal(evaluateChecklist(hw, hw.samplePayload, render(hw.source, hw.samplePayload)).passed, true); assert.match(render(hw.source, hw.samplePayload).text, /Revised requirements: .* confirm access again/);
  const A = { partyId: "A", name: "A", mailingAddress: "1 Test St", email: "a@x.com", consent: a };
  assert.equal(decideChannel(reg.template("NTC_REGZ_41_STMT_STD"), [A])[0]!.reason, "consent reconsent_required (7.4 rule 6)");
  const blocked = decideNoticeChannel(deps, { loan_id: "L-1", notice_id: "N-1", template: "NTC_REGZ_41_STMT_STD", notice_class: "periodic_statements", recipients: [{ party_id: "A", consent: a }] });
  assert.equal(blocked.gate_open, false); assert.deepEqual(blocked.channels.map((x) => x.channel), ["mail"]);
  const gate = engine.byCode("ESIGN_7001C1D_RECONSENT_GATE")[0]!;                                                        // an until-gate anchored on the change's effective date: no clock, closes on re-consent
  assert.equal(gate.status, "armed"); assert.equal(gate.anchorDate, "2027-02-01"); assert.equal(gate.dueDate, undefined); assert.equal(gate.armedByEventId, change.events[0]!.id);
  const noDemo = completeReconsent(deps, { loan_id: "L-1", prior: a, prior_id: "consent-A-1", consent_id: "consent-A-2", link_opened_at: "2027-02-10T15:00:00.000Z", token_entered_at: null, token_ok: false });
  assert.equal(noDemo.consent, null); assert.match(noDemo.refusal!, /demonstration \(link opened \+ PDF token\) is required/); assert.equal(gate.status, "armed");   // no demonstration → still blocked
  const again = completeReconsent(deps, { loan_id: "L-1", prior: a, prior_id: "consent-A-1", consent_id: "consent-A-2", link_opened_at: "2027-02-10T15:00:00.000Z", token_entered_at: "2027-02-10T15:01:00.000Z", token_ok: true });
  assert.equal(again.consent!.status, "active"); assert.equal(again.consent!.reconsent_of, "consent-A-1"); assert.equal(a.status, "reconsent_required");   // append-only: a new row, the old one stands
  assert.deepEqual(again.events.map((e) => e.type), ["consent.esign.reconsented", "consent.esign.active"]);
  assert.equal(gate.status, "satisfied"); assert.equal(gate.satisfiedByEventId, again.events[0]!.id);
  assert.equal(decideChannel(reg.template("NTC_REGZ_41_STMT_STD"), [{ ...A, consent: again.consent! }])[0]!.channel, "email_link");
  // a non-material change is logged, flags nothing and arms no gate; the determination is the officer's
  const minor = announceHwSwChange(deps, { loan_id: "L-1", consents: [again.consent!], effective_on: D("2027-03-01"), change: "font bundle refresh", material: false, determined_by: "officer", hw_sw_version: "hwsw-2027.03" });
  assert.deepEqual(minor.flagged, []); assert.equal(minor.notice, null); assert.equal(again.consent!.status, "active"); assert.equal(engine.byCode("ESIGN_7001C1D_RECONSENT_GATE").length, 1);
  assert.throws(() => announceHwSwChange(deps, { loan_id: "L-1", consents: [b], effective_on: D("2027-02-01"), change: "x", material: true, determined_by: "agent" as "officer", hw_sw_version: "v" }), RangeError);
});
test("7.4-T6: Given a withdrawal by phone on Mar 3 10:00, then by Mar 4 all classes are mail, a mailed confirmation issues, and notices already posted remain accessible.", () => {
  const c = active("A", ["periodic_statements", "arm_notices", "privacy_notices"]);
  const { clock, events, engine } = rig("2027-03-03T15:00:00.000Z"); const deps = { events };                          // Mar 3, 2027 10:00 ET (a Wednesday)
  const rcv = receiveWithdrawal(deps, { loan_id: "L-1", consent_id: "consent-A-1", consent: c, received_at: "2027-03-03T15:00:00.000Z", channel: "phone" });
  assert.equal(rcv.receipt, "2027-03-03"); assert.equal(rcv.effective_by, "2027-03-04"); assert.equal(rcv.event.type, "consent.esign.withdrawal_received"); assert.equal(c.status, "active");   // receipt starts the clock; the application changes the row
  const t = engine.byCode("SM_ESIGN_WITHDRAWAL_EFFECT_1BD")[0]!; assert.equal(t.status, "armed"); assert.equal(t.anchorDate, "2027-03-03"); assert.equal(t.dueDate, "2027-03-04");
  clock.set("2027-03-04T14:00:00.000Z");
  const w = applyWithdrawal(deps, { loan_id: "L-1", consent_id: "consent-A-1", consent: c, on: D("2027-03-04") });
  assert.equal(w.effective_by, "2027-03-05"); assert.equal(c.status, "withdrawn"); assert.equal(w.all_classes_mail, true); assert.deepEqual(w.classes_withdrawn, ["periodic_statements", "arm_notices", "privacy_notices"]); assert.deepEqual(w.classes_remaining, []);
  assert.deepEqual(channelFor([{ party_id: "A", consent: c }], "periodic_statements"), [{ party_id: "A", channel: "mail" }]);
  assert.equal(w.confirmation, "NTC_ESIGN_WITHDRAWAL_CONFIRMATION"); assert.equal(w.confirmation_channel, "mail"); assert.equal(w.prior_records_remain_accessible, true);
  const applied = w.appended.payload as { confirmation_sent: boolean; partial: boolean; all_classes_mail: boolean; prior_records_remain_accessible: boolean; applied_on: string };
  assert.deepEqual([applied.confirmation_sent, applied.partial, applied.all_classes_mail, applied.prior_records_remain_accessible, applied.applied_on], [true, false, true, true, "2027-03-04"]);
  assert.equal(t.status, "satisfied"); assert.equal(t.satisfiedByEventId, w.appended.id); assert.ok(w.applied_on <= t.dueDate!);
  const reg = published(); const conf = reg.template("NTC_ESIGN_WITHDRAWAL_CONFIRMATION");
  assert.equal(decideChannel(conf, [{ partyId: "A", name: "A", mailingAddress: "1 Test St", email: "a@x.com", consent: active("A", ["general_correspondence"]) }])[0]!.reason, "template is mail_only");
  const v = reg.activeVersion("NTC_ESIGN_WITHDRAWAL_CONFIRMATION", D("2027-03-03"))!; assert.match(render(v.source, v.samplePayload).text, /already delivered electronically remain available/);
  // a partial withdrawal (rule 7: "unless the borrower withdraws only some classes") keeps the other classes electronic and still closes its clock
  const p = active("P", ["periodic_statements", "arm_notices"]);
  receiveWithdrawal(deps, { loan_id: "L-1", consent_id: "consent-P-1", consent: p, received_at: "2027-03-04T14:00:00.000Z", channel: "portal", classes: ["periodic_statements"] });
  const tp = engine.byCode("SM_ESIGN_WITHDRAWAL_EFFECT_1BD")[1]!; assert.equal(tp.dueDate, "2027-03-05");
  const partial = applyWithdrawal(deps, { loan_id: "L-1", consent_id: "consent-P-1", consent: p, on: D("2027-03-04"), classes: ["periodic_statements"] });
  assert.equal(partial.all_classes_mail, false); assert.deepEqual(partial.classes_remaining, ["arm_notices"]); assert.equal(p.status, "active"); assert.deepEqual(p.withdrawn_classes, ["periodic_statements"]); assert.equal((partial.appended.payload as { partial: boolean }).partial, true);
  assert.equal(channelFor([{ party_id: "P", consent: p }], "periodic_statements")[0]!.channel, "mail"); assert.equal(channelFor([{ party_id: "P", consent: p }], "arm_notices")[0]!.channel, "electronic"); assert.equal(tp.status, "satisfied");
  assert.equal(withdraw(active("Q", ["arm_notices"]), D("2027-03-03")).effective_by, "2027-03-04");
  assert.throws(() => receiveWithdrawal(deps, { loan_id: "L-1", consent_id: "consent-A-1", consent: c, received_at: "2027-03-05T15:00:00.000Z", channel: "email" }), /nothing to withdraw/);
});
test("7.4-T7: Given a `tcpa_sms` STOP reply, then the number is suppressed immediately and the revocation is applied to all lists within 1 business day (≤ 10 BD).", () => {
  const s = tcpaStop({ number: "+15125550123", reply: "STOP", received_on: D("2026-10-14") });
  assert.equal(s.revocation, true); assert.equal(s.suppressed_immediately, true); assert.equal(s.apply_to_all_lists_by, "2026-10-15"); assert.equal(s.outside_bound, "2026-10-28"); assert.equal(s.recognized_from, "keyword");
  assert.equal(tcpaStop({ number: "+15125550123", reply: "please don't text me anymore", received_on: D("2026-10-14") }).recognized_from, "free_text");
  assert.equal(tcpaStop({ number: "+15125550123", reply: "thanks, got it", received_on: D("2026-10-14") }).revocation, false);
  // the STOP webhook ingestion: number suppressed at receipt, TCPA_REVOCATION_HONOR_10BD armed (+10 BD servicer = Oct 28), closed only when every outbound list is covered
  const { clock, events, engine } = rig("2026-10-14T18:00:00.000Z"); const deps = { events };
  const rcv = receiveTcpaRevocation(deps, { party_id: "A", number: "+15125550123", kind: "tcpa_sms", channel: "sms_reply", reply: "STOP", received_at: "2026-10-14T18:00:00.000Z" });
  assert.deepEqual([rcv.revocation, rcv.recognized_from, rcv.suppressed_immediately, rcv.receipt, rcv.apply_to_all_lists_by, rcv.outside_bound], [true, "keyword", true, "2026-10-14", "2026-10-15", "2026-10-28"]);
  assert.equal((rcv.event!.payload as { suppressed_immediately: boolean }).suppressed_immediately, true);
  const t = engine.byCode("TCPA_REVOCATION_HONOR_10BD")[0]!; assert.equal(t.status, "armed"); assert.equal(t.anchorDate, "2026-10-14"); assert.equal(t.dueDate, "2026-10-28"); assert.deepEqual(t.subject, { kind: "party", id: "A" });
  clock.set("2026-10-15T14:00:00.000Z");
  const smsOnly = applyTcpaRevocation(deps, { party_id: "A", number: "+15125550123", kind: "tcpa_sms", lists: ["sms"], applied_at: "2026-10-15T14:00:00.000Z" });
  assert.equal(smsOnly.applied_to_all_lists, false); assert.deepEqual(smsOnly.missing_lists, ["dialer"]); assert.equal(t.status, "armed");          // the dialer list is still to be updated
  const all = applyTcpaRevocation(deps, { party_id: "A", number: "+15125550123", kind: "tcpa_sms", lists: ["sms", "dialer"], applied_at: "2026-10-15T14:05:00.000Z" });
  assert.equal(all.applied_to_all_lists, true); assert.equal(all.applied_on, "2026-10-15"); assert.ok(all.applied_on <= rcv.apply_to_all_lists_by); assert.equal(t.status, "satisfied"); assert.equal(t.satisfiedByEventId, all.event.id);
  // a non-revocation reply appends nothing and arms nothing; free text is over-recognized; a malformed number is refused
  const thanks = receiveTcpaRevocation(deps, { party_id: "A", number: "+15125550123", kind: "tcpa_sms", channel: "sms_reply", reply: "thanks, got it", received_at: "2026-10-15T14:10:00.000Z" });
  assert.equal(thanks.revocation, false); assert.equal(thanks.event, null); assert.equal(engine.byCode("TCPA_REVOCATION_HONOR_10BD").length, 1);
  assert.equal(receiveTcpaRevocation(deps, { party_id: "B", number: "+15125550124", kind: "tcpa_sms", channel: "sms_reply", reply: "please don't text me anymore", received_at: "2026-10-15T14:10:00.000Z" }).recognized_from, "free_text");
  assert.throws(() => receiveTcpaRevocation(deps, { party_id: "A", number: "5125550123", kind: "tcpa_sms", channel: "sms_reply", reply: "STOP", received_at: "2026-10-15T14:10:00.000Z" }), RangeError);
  assert.throws(() => applyTcpaRevocation(deps, { party_id: "A", number: "+15125550123", kind: "tcpa_sms", lists: [], applied_at: "2026-10-15T14:05:00.000Z" }), RangeError);
});
test("7.4-T8: Given a transfer-in file with `estatement_flag=Y` and no evidence, then the loan boards with mail delivery and an invitation is included with the hello notice.", () => {
  assert.deepEqual(transferInEstatementFlag({ estatement_flag: "Y", evidence: null }), { delivery: "mail", consent_status: null, invitation_with_hello: true });
  assert.equal(transferInEstatementFlag({ estatement_flag: "Y", evidence: { checkbox_text: "I agree to e-statements", demonstration_proof_id: "proof-1" } }).consent_status, "evidence_only");
});
test("7.4-T9: Given `irs_estatement` consent is absent, then the 1098 is furnished on paper even if `periodic_statements` consent is active.", () => {
  assert.equal(irs1098Channel(false), "paper"); assert.equal(irs1098Channel(true), "electronic");
  const reg = buildRegistry(); const irs = reg.template("NTC_IRS_1098"); assert.equal(irs.noticeClass, "irs_estatement");
  const A = { partyId: "A", name: "A", mailingAddress: "1 Test St", email: "a@x.com", consent: active("A", ["periodic_statements"]) };
  assert.equal(decideChannel(irs, [A])[0]!.channel, "mail_first_class"); assert.equal(decideChannel(irs, [A])[0]!.reason, "consent does not cover class irs_estatement (7.4 rule 1)");
  assert.equal(decideChannel(irs, [{ ...A, consent: active("A", ["periodic_statements", "irs_estatement"]) }])[0]!.channel, "email_link");
  // the furnish request: IRS_1098_ECONSENT_GATE arms on the electronic request; its evaluator closes without irs_estatement consent → paper by Jan 31
  const { events, engine } = rig("2027-01-05T15:00:00.000Z"); const deps = { events };
  const paper = requestForm1098Furnish(deps, { loan_id: "L-1", tax_year: 2026, party_id: "A", channel: "electronic", consents: [A.consent] });
  assert.deepEqual([paper.gate_open, paper.furnish_channel, paper.irs_estatement_consent_active, paper.furnish_by], [false, "paper", false, "2027-01-31"]); assert.match(paper.gate_reason!, /periodic_statements consent does not qualify/);
  const gate = engine.byCode("IRS_1098_ECONSENT_GATE")[0]!; assert.equal(gate.status, "armed"); assert.equal(gate.note, "evaluator:7.4.irsEstatementConsentActive"); assert.equal(gate.armedByEventId, paper.event.id);
  const withIrs = requestForm1098Furnish(deps, { loan_id: "L-1", tax_year: 2026, party_id: "A", channel: "electronic", consents: [A.consent, active("A", ["irs_estatement"])] });
  assert.equal(withIrs.gate_open, true); assert.equal(withIrs.furnish_channel, "electronic"); assert.equal(withIrs.irs_estatement_consent_active, true);
  const paperRequest = requestForm1098Furnish(deps, { loan_id: "L-1", tax_year: 2026, party_id: "B", channel: "paper", consents: [active("B", ["irs_estatement"])] });
  assert.equal(paperRequest.furnish_channel, "paper"); assert.equal(engine.byCode("IRS_1098_ECONSENT_GATE").length, 2);                                   // a paper furnish never arms the gate
  assert.equal(events.ofType("tax_form.1098.furnish_requested").length, 3);
  assert.throws(() => requestForm1098Furnish(deps, { loan_id: "L-1", tax_year: 26, party_id: "A", channel: "paper", consents: [] }), RangeError);
});
test("7.4-T10: Given a state-mandated-mail notice (e.g., NY RPAPL 1304 pre-foreclosure notice), then the channel is mail regardless of consent.", () => {
  const reg = buildRegistry();
  const A = { partyId: "A", name: "A", mailingAddress: "1 Test St", email: "a@x.com", consent: active("A", ["periodic_statements", "state_notices", "lossmit", "servicing_general"]) };
  const ny = reg.template("NTC_STATE_PREFC_NY_1304"); assert.equal(ny.channelPolicy, "mail_only"); assert.equal(ny.separateDocument, true);
  assert.equal(decideChannel(ny, [A])[0]!.reason, "template is mail_only");
  assert.equal(decideChannel(reg.template("NTC_REGZ_41_STMT_STD"), [A], { stateMandatedMail: true })[0]!.reason, "state-mandated mail (7.4-T10)");
  assert.deepEqual(channelFor([{ party_id: "A", consent: A.consent }], "periodic_statements", true), [{ party_id: "A", channel: "mail" }]);
  const { events, engine } = rig("2026-11-02T15:00:00.000Z");
  const d = decideNoticeChannel({ events }, { loan_id: "L-1", notice_id: "N-1", template: "NTC_STATE_PREFC_NY_1304", notice_class: "state_notices", recipients: [{ party_id: "A", consent: A.consent }], state_mandated_mail: true });
  assert.equal(d.requested_channel, "mail"); assert.deepEqual(d.channels.map((x) => [x.channel, x.consent_active, x.covers_class]), [["mail", true, true]]); assert.equal(engine.byCode("ESIGN_7001C_CONSENT_GATE").length, 0);   // never requests electronic: no gate
});
test("7.4-T11: Given a consent record, when queried for exam, then the disclosure text version, hash, timestamps, IP/user-agent and verification proof are reproducible (7001(d)).", () => {
  const c = newConsent("A", ["periodic_statements", "arm_notices"], "v1.3", D("2026-10-02"), "portal"); if ("error" in c) throw new Error(c.error); verify(c, true, true, D("2026-10-02"));
  const r = consentExamRecord(c, { disclosure_version: "v1.3", disclosure_hash: "sha256:7f3a", consented_at: "2026-10-02T14:14:00Z", verification_link_opened_at: "2026-10-02T14:20:00Z", token_entered_at: "2026-10-02T14:21:00Z", ip: "203.0.113.7", user_agent: "Mozilla/5.0", token_ok: true });
  assert.equal(r.reproducible, true); assert.deepEqual(r.missing, []); assert.equal(r.fields.disclosure_hash, "sha256:7f3a"); assert.equal(r.fields.verification.token_ok, true); assert.equal(r.fields.ip, "203.0.113.7");
  assert.deepEqual(consentExamRecord(c, { disclosure_version: "v1.3", disclosure_hash: "", consented_at: "2026-10-02T14:14:00Z", verification_link_opened_at: null, token_entered_at: null, ip: "", user_agent: "x", token_ok: false }).missing, ["disclosure_hash", "ip", "verification_proof"]);
  // the exam timeline is the event spine itself: disclosure (version + hash), click, both verification instants with IP/user-agent
  const { events } = rig("2026-10-02T14:21:00.000Z"); const deps = { events };
  const cap = captureConsent(deps, { loan_id: "L-1", party_id: "A", consent_id: "consent-A-1", classes: ["periodic_statements", "arm_notices"], disclosure_version: "v1.3", disclosure_hash: "sha256:7f3a", clicked_at: "2026-10-02T14:14:00.000Z", captured_via: "portal", ...EVIDENCE });
  completeVerification(deps, { loan_id: "L-1", consent_id: "consent-A-1", consent: cap.consent, link_opened_at: "2026-10-02T14:20:00.000Z", token_entered_at: "2026-10-02T14:21:00.000Z", token_ok: true, ...EVIDENCE });
  const timeline = events.all().filter((e) => e.type.startsWith("consent.esign.")).map((e) => [e.type, e.payload] as const);
  assert.deepEqual(timeline.map(([t]) => t), ["consent.esign.disclosed", "consent.esign.pending", "consent.esign.verified", "consent.esign.active"]);
  assert.deepEqual([timeline[0]![1].disclosure_version, timeline[0]![1].disclosure_hash, timeline[1]![1].clicked_at, timeline[1]![1].ip, timeline[2]![1].link_opened_at, timeline[2]![1].token_entered_at, timeline[2]![1].user_agent], ["v1.3", "sha256:7f3a", "2026-10-02T14:14:00.000Z", "203.0.113.7", "2026-10-02T14:20:00.000Z", "2026-10-02T14:21:00.000Z", "Mozilla/5.0"]);
});
test("7.4 SM_CONSENT_REVALIDATION_12M: arms on consent.esign.active at verified_at + 12 months; a portal view's consent.esign.revalidated closes it; dormancy is informational only", () => {
  const { clock, events, engine } = rig("2026-10-02T14:21:00.000Z"); const deps = { events };
  const cap = captureConsent(deps, { loan_id: "L-1", party_id: "A", consent_id: "consent-A-1", classes: ["periodic_statements"], disclosure_version: "v1.3", disclosure_hash: "sha256:7f3a", clicked_at: "2026-10-02T14:14:00.000Z", captured_via: "portal", ...EVIDENCE });
  const done = completeVerification(deps, { loan_id: "L-1", consent_id: "consent-A-1", consent: cap.consent, link_opened_at: "2026-10-02T14:20:00.000Z", token_entered_at: "2026-10-02T14:21:00.000Z", token_ok: true, ...EVIDENCE });
  const t = engine.byCode("SM_CONSENT_REVALIDATION_12M")[0]!;
  assert.equal(t.status, "armed"); assert.equal(t.anchorDate, "2026-10-02"); assert.equal(t.dueDate, "2027-10-02"); assert.equal(t.armedByEventId, done.events[1]!.id);   // anchor verified_at, +12 months
  const def = loadOverriddenRegistry().get("SM_CONSENT_REVALIDATION_12M")!;
  assert.ok(eventMatches(def.triggerPattern!, done.events[1]!)); assert.equal(def.kindNorm, "recurring"); assert.equal(def.severity.level, null);
  // the Oct 17 statement viewed in the portal → revalidated through Oct 17, 2027. Satisfaction is proved with eventMatches on a side store: the kernel's
  // recurring re-arm inside its own satisfy loop (src/kernel/timers/engine.ts onEvent) re-satisfies the fresh instance with the same event and never returns.
  clock.set("2026-10-17T15:00:00.000Z"); const side = new MemoryEventStore(clock);
  const view = recordPortalView({ events: side }, { loan_id: "L-1", consent_id: "consent-A-1", consent: cap.consent, notice_id: "N-1", viewed_at: "2026-10-17T15:00:00.000Z" });
  assert.equal(view.revalidated, true); assert.equal(view.revalidated_through, "2027-10-17"); assert.deepEqual(view.events.map((e) => e.type), ["edelivery.viewed", "consent.esign.revalidated"]);
  assert.ok(eventMatches(def.satisfiedPattern!, view.events[1]!)); assert.ok(!eventMatches(def.satisfiedPattern!, view.events[0]!));
  assert.equal(recordPortalView({ events: side }, { loan_id: "L-1", consent_id: "consent-P-1", consent: newConsent("P", ["periodic_statements"], "v1.3", D("2026-10-02"), "portal") as Consent, notice_id: "N-2", viewed_at: "2026-10-17T15:00:00.000Z" }).revalidated, false);   // a pending consent is not revalidated by a view
  const fresh = revalidationCheck({ consent: cap.consent, portal_views_at: ["2027-06-01T12:00:00.000Z"], as_of: D("2027-10-02") });
  assert.deepEqual(fresh, { due_on: "2027-10-02", dormant: false, revalidated: true, forced_reconsent: false, action: "none_informational" });
  const dormant = revalidationCheck({ consent: cap.consent, portal_views_at: ["2026-09-30T12:00:00.000Z"], as_of: D("2027-10-02") });
  assert.deepEqual([dormant.dormant, dormant.revalidated, dormant.forced_reconsent, dormant.action], [true, false, false, "none_informational"]); assert.equal(cap.consent.status, "active");   // open question 3: no forced re-consent
  assert.equal(engine.evaluate("2027-10-03T12:00:00.000Z").filter((b) => b.instance.code === "SM_CONSENT_REVALIDATION_12M")[0]!.severity, null);   // breach "none — informational"
});
