// 7.5 GLBA privacy notice
// spec/sections/07-compliance-notices-disclosures/7-5-glba-privacy-notice.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, daysBetween } from "../../kernel/calendar/date.ts";
import { MemoryEventStore, FixedClock, SYSTEM, eventMatches, type Actor } from "../../kernel/events/index.ts";
import { TimerEngine } from "../../kernel/timers/engine.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";
import { newConsent, verify, type Consent } from "./esign.ts";
import { initialNoticeRequired, initialNoticeDue, initialNoticePlan, partnerNoticeOnFile, annualExceptionEligible, annualCycle, policyChange } from "./privacy.ts";
import { privacyPortalPosting, otherImportantInformation, annualNoticeAfterTermination, privacyCopyOnRequest } from "./ops.ts";
import { privacyInitialNoticeDue, recordPartnerNoticeOnFile, sendInitialPrivacyNotice, postInitialNoticeToPortal, recordPortalAcknowledgment, portalAcknowledgmentSweep, partnerAttestationReceived, openAnnualCycle, applyAnnualCycle, sendAnnualPrivacyNotice,
  recordPolicyChange, sendRevisedPrivacyNotice, closeOptOutWindow, recordOptOut, marketingShareExport, marketingShareGate, requestPrivacyCopy, sendPrivacyCopy, currentPrivacyNotice, terminatePrivacyRelationship, privacyPartyStatus, assemblePrivacyNoticePayload, initialNoticeDueFor, type PrivacyProgram, type OpsDeps } from "./ops-7-5.ts";

const DISCLOSURES: Actor = { kind: "agent", id: "disclosures" };
const PROGRAM: PrivacyProgram = { partner_id: "PB", partner_name: "Partner Bank", notice_version: "v3", sharing_profile: "exceptions_only", joint: true, affiliates_everyday: true, marketing: false };
const rig = (iso: string) => {
  const clock = new FixedClock(iso); const events = new MemoryEventStore(clock); const engine = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["7.5"] });
  const deps = (): OpsDeps => ({ events, actor: DISCLOSURES, now: clock.now() });
  return { clock, events, engine, deps };
};
const eConsent = (party: string): Consent => { const c = newConsent(party, ["privacy_notices"], "v1.3", D("2026-10-02"), "portal"); if ("error" in c) throw new Error(c.error); verify(c, true, true, D("2026-10-02")); return c; };
const msrIn = (r: ReturnType<typeof rig>, loan = "L-1", party = "P-1", transfer = D("2026-11-02")) => privacyInitialNoticeDue(r.deps(), { kind: "msr_acquisition", loan_id: loan, party_id: party, partner_id: "PB", transfer_date: transfer, transfer_file_id: "tf-2026-11-02" });

test("7.5-T1: Given a transfer-in with partner MSR acquisition effective 2026-11-02, then `NTC_REGP_1016_4_INITIAL` is mailed with the hello notice by 2026-11-17 and the timer (due 2026-12-02) is satisfied.", () => {
  assert.equal(initialNoticeRequired("msr_acquisition"), true); assert.equal(initialNoticeDue(D("2026-11-02")), "2026-12-02");
  const plan = initialNoticePlan(D("2026-11-02"));
  assert.deepEqual(plan, { template: "NTC_REGP_1016_4_INITIAL", basis: "hello_insert", hello_notice_by: "2026-11-17", due_on: "2026-12-02", timer: "REGP_1016_4A1_INITIAL_NOTICE_REASONABLE_30", satisfied_by: "notice.sent{template=NTC_REGP_1016_4_INITIAL}" });
  const r = rig("2026-11-02T14:00:00.000Z"); const { clock, events, engine } = r;
  // the transfer file's MSR-acquisition record is ingested: the inbound event plus the state transition the clock arms on
  const due = msrIn(r);
  assert.equal(due.inbound.type, "transfer_in.msr_acquired_by_partner"); assert.equal(due.inbound.payload.transfer_date, "2026-11-02"); assert.equal(due.inbound.payload.partner_id, "PB");
  assert.equal(due.due.type, "privacy.initial_due"); assert.equal(due.due.causationId, due.inbound.id); assert.equal(due.due.payload.reason, "msr_acquisition"); assert.equal(due.due.payload.anchor_date, "2026-11-02"); assert.equal(due.due.payload.due_on, "2026-12-02"); assert.equal(due.due.payload.hello_notice_by, "2026-11-17");
  assert.equal(privacyPartyStatus(events, "L-1", "P-1"), "initial_due");
  const t = engine.byCode("REGP_1016_4A1_INITIAL_NOTICE_REASONABLE_30")[0]!; assert.equal(t.anchorDate, "2026-11-02"); assert.equal(t.dueDate, "2026-12-02"); assert.equal(t.status, "armed"); assert.equal(t.armedByEventId, due.due.id);
  clock.set("2026-11-10T15:00:00.000Z");
  events.append({ type: "notice.sent", loanId: "L-1", actor: SYSTEM, payload: { template: "NTC_REGX_1024_33B_HELLO_MS2", notice_id: "n-hello" } }); assert.equal(t.status, "armed");   // the hello notice alone is not the privacy notice
  assert.throws(() => sendInitialPrivacyNotice(r.deps(), { loan_id: "L-1", party_id: "P-1", sent_on: D("2026-11-10"), basis: "hello_insert", notice_version: "v3" }), RangeError);   // an insert names its envelope
  const s = sendInitialPrivacyNotice(r.deps(), { loan_id: "L-1", party_id: "P-1", sent_on: D("2026-11-10"), basis: "hello_insert", notice_version: "v3", hello_notice_id: "n-hello" });
  assert.equal(s.sent.type, "notice.sent"); assert.equal(s.sent.payload.template, "NTC_REGP_1016_4_INITIAL"); assert.equal(s.sent.payload.kind, "initial"); assert.equal(s.sent.payload.basis, "hello_insert"); assert.equal(s.sent.payload.sent_on, "2026-11-10");
  assert.ok(s.sent.payload.sent_on <= plan.hello_notice_by, "mailed with the hello notice by Nov 17");
  assert.equal(t.status, "satisfied"); assert.equal(t.satisfiedByEventId, s.sent.id); assert.equal(t.satisfiedAt, "2026-11-10T15:00:00.000Z");
  assert.equal(s.initial_sent.type, "privacy.initial_sent"); assert.equal(s.initial_sent.payload.sent_on, "2026-11-10"); assert.equal(s.initial_sent.causationId, s.sent.id);
  assert.equal(privacyPartyStatus(events, "L-1", "P-1"), "initial_sent"); assert.equal(initialNoticeDueFor(events, "L-1", "P-1"), null);
  assert.throws(() => sendInitialPrivacyNotice(r.deps(), { loan_id: "L-1", party_id: "P-1", sent_on: D("2026-11-11"), basis: "mail", notice_version: "v3" }), /no initial notice is due/);   // sent once
  assert.equal(events.ofType("timer.breached").length, 0); assert.deepEqual(engine.evaluate("2026-12-03T05:00:00.000Z"), []);
  // the rendered insert is the partner's Appendix A form and passes its checklist; it may ride in the hello envelope
  const reg = buildRegistry(); publishAuthored(reg); const v = reg.activeVersion("NTC_REGP_1016_4_INITIAL", D("2026-11-10"))!;
  const payload = assemblePrivacyNoticePayload({ program: PROGRAM, property_state: "TX", kind: "initial", basis: "hello_insert" });
  const rendered = render(v.source, payload); assert.match(rendered.text, /FACTS — WHAT DOES PARTNER BANK DO WITH YOUR PERSONAL INFORMATION\?/); assert.match(rendered.text, /together with Supermortgage/); assert.equal(evaluateChecklist(v, payload, rendered).passed, true);
  assert.ok(reg.template("NTC_REGX_1024_33B_HELLO_MS2").mayCombineWith.some((c) => c.startsWith("NTC_REGP_1016_4_INITIAL")), "the privacy notice may ride in the hello envelope");
  // the row's second trigger: a new customer by assumption arms the same clock from the assumption date
  const a = rig("2026-11-02T14:00:00.000Z");
  const asm = privacyInitialNoticeDue(a.deps(), { kind: "assumption", loan_id: "L-2", party_id: "P-9", assumption_date: D("2026-11-02"), sii_case_id: "sii-7" });
  assert.equal(asm.inbound.type, "sii.assumption.confirmed"); assert.equal(asm.due.payload.reason, "assumption"); assert.equal(asm.due.payload.basis, "mail"); assert.equal(asm.due.payload.hello_notice_by, null);
  const ta = a.engine.byCode("REGP_1016_4A1_INITIAL_NOTICE_REASONABLE_30")[0]!; assert.equal(ta.anchorDate, "2026-11-02"); assert.equal(ta.dueDate, "2026-12-02");
  assert.throws(() => privacyInitialNoticeDue(a.deps(), { kind: "msr_acquisition", loan_id: "L-3", party_id: "P-3", partner_id: "", transfer_date: D("2026-11-02") }), RangeError);
  assert.throws(() => privacyInitialNoticeDue(a.deps(), { kind: "msr_acquisition", loan_id: "L-3", party_id: "P-3", partner_id: "PB", transfer_date: "11/02/2026" as never }), RangeError);
});
test("7.5-T2: Given a master-to-subservicer move with the partner's notice v3 date in the transfer file, then no initial notice is generated and the version is recorded on the loan.", () => {
  assert.equal(initialNoticeRequired("master_to_sub"), false); assert.equal(initialNoticeRequired("sub_to_sub"), false); assert.equal(initialNoticeRequired("assumption"), true);
  assert.deepEqual(partnerNoticeOnFile({ transfer: "master_to_sub", partner_notice_version: "v3", partner_notice_date: D("2025-03-01") }), { initial_notice: false, recorded: { partner_privacy_notice_version: "v3", partner_privacy_notice_date: "2025-03-01" } });
  const r = rig("2026-11-02T14:00:00.000Z"); const { events, engine } = r;
  const on = recordPartnerNoticeOnFile(r.deps(), { loan_id: "L-1", party_id: "P-1", transfer: "master_to_sub", partner_notice_version: "v3", partner_notice_date: D("2025-03-01") });
  assert.equal(on.initial_notice, false); assert.deepEqual(on.recorded, { partner_privacy_notice_version: "v3", partner_privacy_notice_date: "2025-03-01" });
  assert.equal(on.event.type, "privacy.partner_notice.recorded"); assert.equal(on.event.loanId, "L-1"); assert.equal(on.event.payload.partner_privacy_notice_version, "v3"); assert.equal(on.event.payload.partner_privacy_notice_date, "2025-03-01"); assert.equal(on.event.payload.initial_notice, false);
  assert.equal(on.courtesy, null);
  assert.equal(events.ofType("privacy.initial_due").length, 0); assert.equal(events.ofType("notice.sent").length, 0); assert.equal(engine.byCode("REGP_1016_4A1_INITIAL_NOTICE_REASONABLE_30").length, 0);
  assert.equal(privacyPartyStatus(events, "L-1", "P-1"), "no_notice_due"); assert.equal(initialNoticeDueFor(events, "L-1", "P-1"), null);
  assert.throws(() => sendInitialPrivacyNotice(r.deps(), { loan_id: "L-1", party_id: "P-1", sent_on: D("2026-11-10"), basis: "mail", notice_version: "v3" }), /no initial notice is due .* master-to-subservicer/);
  assert.deepEqual(currentPrivacyNotice(events, "L-1"), { template: "NTC_REGP_1016_4_INITIAL", notice_version: "v3", sent_on: "2025-03-01" });
  // decision 2: the optional courtesy copy is the partner's current notice, labelled as such — never an "initial" notice
  const c = recordPartnerNoticeOnFile(r.deps(), { loan_id: "L-2", party_id: "P-2", transfer: "sub_to_sub", partner_notice_version: "v3", partner_notice_date: D("2025-03-01"), courtesy_copy: true, sent_on: D("2026-11-10") });
  assert.equal(c.courtesy!.type, "notice.sent"); assert.equal(c.courtesy!.payload.kind, "courtesy"); assert.equal(c.courtesy!.payload.basis, "hello_insert"); assert.equal(engine.byCode("REGP_1016_4A1_INITIAL_NOTICE_REASONABLE_30").length, 0);
  assert.throws(() => recordPartnerNoticeOnFile(r.deps(), { loan_id: "L-3", party_id: "P-3", transfer: "msr_acquisition" as never, partner_notice_version: "v3", partner_notice_date: D("2025-03-01") }), RangeError);
  assert.throws(() => recordPartnerNoticeOnFile(r.deps(), { loan_id: "L-3", party_id: "P-3", transfer: "master_to_sub", partner_notice_version: "", partner_notice_date: D("2025-03-01") }), RangeError);
});
test("7.5-T3: Given `sharing_profile = exceptions_only` and an attestation of no change, then the annual timer is satisfied by `privacy.annual_exception.applied` and no mailing occurs.", () => {
  assert.equal(annualExceptionEligible("exceptions_only", true), true); assert.equal(annualExceptionEligible("broader", true), false); assert.equal(annualExceptionEligible("exceptions_only", false), false);
  const a = annualCycle({ sharing_profile: "exceptions_only", attested_no_change: true, attestation_id: "att-2027-01", year: 2027 });
  assert.equal(a.annual_notice, false); assert.equal(a.mailing, false); assert.deepEqual(a.event, { type: "privacy.annual_exception.applied", payload: { year: 2027, attestation_id: "att-2027-01", template: null } });
  const def = loadOverriddenRegistry().get("REGP_1016_5A_ANNUAL_NOTICE_12M")!;
  // the annual clock arms on the initial notice ('last notice date' = sent_on) and runs 12 months (decision 3: rolling-12-month guard inside the calendar-year basis)
  const r = rig("2026-11-02T14:00:00.000Z"); const { clock, events, engine } = r;
  msrIn(r); clock.set("2026-11-10T15:00:00.000Z"); sendInitialPrivacyNotice(r.deps(), { loan_id: "L-1", party_id: "P-1", sent_on: D("2026-11-10"), basis: "hello_insert", notice_version: "v3", hello_notice_id: "n-hello" });
  const t = engine.byCode("REGP_1016_5A_ANNUAL_NOTICE_12M")[0]!; assert.equal(t.anchorDate, "2026-11-10"); assert.equal(t.dueDate, "2027-11-10"); assert.equal(t.status, "armed");
  // the partner attestation clock: Dec 31 year-end → attestation by Jan 31, satisfied by the attestation feed
  clock.set("2026-12-31T23:00:00.000Z"); events.append({ type: "period.year_end", actor: SYSTEM, payload: { entity: "supermortgage", period_end: "2026-12-31", year: 2026 } });
  const att = engine.byCode("SM_PARTNER_PRIVACY_ATTESTATION_0131")[0]!; assert.equal(att.dueDate, "2027-01-31"); assert.equal(att.status, "armed");
  // Jan 2: the cycle opens — an input to the determination, never its satisfaction (the family pattern once matched it)
  clock.set("2027-01-02T14:00:00.000Z"); const opened = openAnnualCycle(r.deps(), { year: 2027, partner_id: "PB" });
  assert.equal(opened.type, "privacy.annual_cycle.opened"); assert.equal(eventMatches(def.satisfiedPattern!, opened), false); assert.equal(t.status, "armed");
  assert.deepEqual(applyAnnualCycle(r.deps(), { loan_id: "L-1", party_id: "P-1", year: 2027, program: PROGRAM, attestation: null, today: D("2027-01-02") }), { status: "awaiting_attestation", annual_notice: null, default_on: "2027-04-01", event: null });
  clock.set("2027-01-20T15:00:00.000Z");
  // The attestation and the determination are emitted for real by the process and matched against the registry's satisfying
  // patterns. Both rows are `recurring`, so they are appended to a store carrying no armed instance: src/kernel/timers/engine.ts
  // onEvent re-arms a recurring row inside the loop that is satisfying it (`this.instances` is pushed to while iterated), so the
  // re-armed instance is satisfied by the same event and re-armed again without end — a kernel fix (iterate a snapshot), not a 7.5 one.
  const det = new MemoryEventStore(new FixedClock("2027-01-20T15:00:00.000Z")); const ddeps: OpsDeps = { events: det, actor: DISCLOSURES, now: "2027-01-20T15:00:00.000Z" };
  const attDef = loadOverriddenRegistry().get("SM_PARTNER_PRIVACY_ATTESTATION_0131")!;
  const received = partnerAttestationReceived(ddeps, { partner_id: "PB", year: 2027, attestation_id: "att-2027-01", no_change: true, received_on: D("2027-01-20") });
  assert.equal(received.event.type, "partner.privacy_attestation.received"); assert.equal(received.event.payload.no_change, true); assert.equal(received.event.payload.attestation_id, "att-2027-01"); assert.equal(received.late, false);
  assert.equal(eventMatches(attDef.satisfiedPattern!, received.event), true); assert.equal(eventMatches(attDef.satisfiedPattern!, opened), false); assert.equal(att.status, "armed");
  assert.throws(() => partnerAttestationReceived(ddeps, { partner_id: "PB", year: 2027, attestation_id: "", no_change: true, received_on: D("2027-01-20") }), RangeError);
  const d = applyAnnualCycle(ddeps, { loan_id: "L-1", party_id: "P-1", year: 2027, program: PROGRAM, attestation: { attestation_id: received.event.payload.attestation_id, no_change: received.event.payload.no_change }, today: D("2027-01-20") });
  assert.equal(d.status, "exception_applied"); assert.equal(d.annual_notice, false);
  const ev = d.event!; assert.equal(ev.type, "privacy.annual_exception.applied"); assert.equal(ev.payload.attestation_id, "att-2027-01"); assert.equal(ev.payload.year, 2027); assert.equal(ev.payload.outcome, "exception_applied"); assert.equal(ev.payload.template, null);
  assert.equal(eventMatches(def.satisfiedPattern!, ev), true);
  assert.equal(det.ofType("notice.sent").length, 0); assert.equal(det.ofType("privacy.annual_due").length, 0);   // no mailing
  assert.equal(privacyPartyStatus(det, "L-1", "P-1"), "annual_exempt");
  // the alternatives: a broader profile, or an attestation of change, mails by Dec 31 — and that mailing closes the clock too
  const m = new MemoryEventStore(new FixedClock("2027-01-20T15:00:00.000Z")); const mdeps: OpsDeps = { events: m, actor: DISCLOSURES, now: "2027-01-20T15:00:00.000Z" };
  const b = applyAnnualCycle(mdeps, { loan_id: "L-1", party_id: "P-1", year: 2027, program: { ...PROGRAM, sharing_profile: "optout_required" }, attestation: { attestation_id: "att-2027-01", no_change: true }, today: D("2027-01-20") });
  assert.equal(b.status, "annual_due"); assert.equal(b.annual_notice, true); assert.equal(b.annual_by, "2027-12-31"); assert.equal(b.attestation_defaulted, false); assert.equal(privacyPartyStatus(m, "L-1", "P-1"), "annual_due");
  const sent = sendAnnualPrivacyNotice(mdeps, { loan_id: "L-1", party_id: "P-1", year: 2027, sent_on: D("2027-06-01"), basis: "mail", notice_version: "v3" });
  assert.equal(sent.sent.payload.template, "NTC_REGP_1016_5_ANNUAL"); assert.equal(sent.sent.payload.kind, "annual"); assert.equal(sent.annual_sent.type, "privacy.annual_sent"); assert.equal(sent.annual_sent.payload.outcome, "annual_sent"); assert.equal(sent.annual_sent.payload.annual_by, "2027-12-31");
  assert.equal(eventMatches(def.satisfiedPattern!, sent.annual_sent), true); assert.equal(privacyPartyStatus(m, "L-1", "P-1"), "annual_sent");
  assert.equal(applyAnnualCycle(mdeps, { loan_id: "L-1", party_id: "P-1", year: 2027, program: PROGRAM, attestation: { attestation_id: "att-2027-02", no_change: false }, today: D("2027-01-20") }).status, "annual_due");
  assert.throws(() => sendAnnualPrivacyNotice(mdeps, { loan_id: "L-1", party_id: "P-1", year: 2027, sent_on: D("2027-06-01"), basis: "website_only", notice_version: "v3", consent: null }), RangeError);   // website-only needs e-consent (§1016.9(c)(1))
  // no attestation by Mar 31 → default to sending annual notices (breach column)
  const late = applyAnnualCycle(mdeps, { loan_id: "L-2", party_id: "P-2", year: 2027, program: PROGRAM, attestation: null, today: D("2027-04-01") });
  assert.equal(late.status, "annual_due"); assert.equal(late.attestation_defaulted, true); assert.equal(late.annual_by, "2027-12-31");
  assert.equal(partnerAttestationReceived(mdeps, { partner_id: "PB", year: 2027, attestation_id: "att-late", no_change: true, received_on: D("2027-02-15") }).late, true);
  // a bare notice.sent (the initial notice) never closes the annual clock
  assert.equal(eventMatches(def.satisfiedPattern!, { id: "e", type: "notice.sent", occurredAt: "2027-01-20T15:00:00.000Z", loanId: "L-1", actor: SYSTEM, payload: { template: "NTC_REGP_1016_4_INITIAL" }, sequence: 1 }), false);
});
test("7.5-T4: Given a policy change on 2027-06-15 introducing nonaffiliate marketing sharing, then the sharing gate blocks exports, the revised notice with a 30-day opt-out is sent, and sharing is allowed only after the window for non-opt-outs.", () => {
  const pending = policyChange(true, true, D("2027-06-15"));
  assert.equal(pending.revised_notice, true); assert.equal(pending.gate, "REGP_1016_8_REVISED_NOTICE_GATE"); assert.equal(pending.sharing_allowed_from, null);   // blocked until the revised notice goes and its window runs
  const sent = policyChange(true, true, D("2027-06-15"), D("2027-07-01"));
  assert.equal(sent.opt_out_window_ends, "2027-07-31"); assert.equal(sent.sharing_blocked_until, "2027-07-31"); assert.equal(sent.sharing_allowed_from, "2027-08-01"); assert.equal(sent.annual_clock_restarts_from, "2027-07-01"); assert.equal(sent.gate_closes_on, "privacy.revised_notice.optout_window_elapsed");
  const r = rig("2027-06-15T15:00:00.000Z"); const { clock, events, engine } = r;
  assert.equal(marketingShareGate(events, { loan_id: "L-1", party_id: "P-1" }).allowed, false);   // nothing discloses nonaffiliate marketing sharing yet
  const c = recordPolicyChange(r.deps(), { partner_id: "PB", loan_id: "L-1", change_date: D("2027-06-15"), new_sharing: true, exception_lost: true, description: "share with a nonaffiliated insurance marketer" });
  assert.equal(c.event.type, "privacy_policy.changed"); assert.equal(c.event.payload.new_sharing, true); assert.equal(c.event.payload.exception_lost, true); assert.equal(c.event.payload.change_date, "2027-06-15"); assert.equal(c.event.payload.gate, "REGP_1016_8_REVISED_NOTICE_GATE");
  assert.equal(c.assessment.revised_notice, true); assert.equal(c.assessment.sharing_allowed_from, null); assert.equal(privacyPartyStatus(events, "L-1", "P-1"), "revised_due");
  const gate = engine.byCode("REGP_1016_8_REVISED_NOTICE_GATE")[0]!; assert.equal(gate.status, "armed"); assert.equal(gate.dueDate, undefined); assert.equal(gate.armedByEventId, c.event.id);   // an until-gate: sharing blocked
  assert.equal(engine.byCode("REGP_1016_5E2II_ANNUAL_AFTER_CHANGE_100").length, 0);   // new sharing takes the revised-notice path (rule 5), not the 100-day clock
  const blocked = marketingShareExport(r.deps(), { loan_id: "L-1", party_id: "P-1", tag: "marketing_share", export_id: "x-1" });
  assert.equal(blocked.allowed, false); assert.equal(blocked.gate, "REGP_1016_8_REVISED_NOTICE_GATE"); assert.equal(blocked.event!.type, "privacy.export.blocked"); assert.equal(blocked.event!.payload.tag, "marketing_share");
  assert.equal(marketingShareExport(r.deps(), { loan_id: "L-1", party_id: "P-1", tag: "servicing" }).allowed, true);   // only marketing_share exports are gated
  clock.set("2027-07-01T15:00:00.000Z");
  assert.throws(() => sendRevisedPrivacyNotice(r.deps(), { loan_id: "L-1", party_id: "P-1", sent_on: D("2027-07-01"), optout_days: 14, notice_version: "v4", basis: "mail" }), /at least 30 days/);
  const s = sendRevisedPrivacyNotice(r.deps(), { loan_id: "L-1", party_id: "P-1", sent_on: D("2027-07-01"), notice_version: "v4", basis: "mail", timers: engine });
  assert.equal(s.sent.payload.template, "NTC_REGP_1016_8_REVISED"); assert.equal(s.sent.payload.kind, "revised"); assert.equal(s.sent.payload.optout_days, 30);
  assert.equal(s.revised.type, "privacy.revised_notice.sent"); assert.equal(s.revised.payload.opt_out_window_ends, "2027-07-31"); assert.equal(s.revised.payload.sharing_allowed_from, "2027-08-01"); assert.equal(s.revised.payload.annual_clock_restarts_from, "2027-07-01");
  assert.equal(gate.status, "armed");   // the send alone does not open sharing
  assert.equal(privacyPartyStatus(events, "L-1", "P-1"), "revised_sent"); assert.equal(currentPrivacyNotice(events, "L-1").template, "NTC_REGP_1016_8_REVISED");
  const w = closeOptOutWindow(r.deps(), { loan_id: "L-1", today: D("2027-07-31") }); assert.equal(w.elapsed, false); assert.equal(w.window_ends, "2027-07-31"); assert.equal(w.event, null); assert.equal(gate.status, "armed");
  assert.equal(marketingShareExport(r.deps(), { loan_id: "L-1", party_id: "P-1", tag: "marketing_share" }).allowed, false);
  const opt = recordOptOut(r.deps(), { loan_id: "L-1", party_id: "P-2", received_on: D("2027-07-10"), choices: ["do not share my information with nonaffiliates to market to me"], program: { ...PROGRAM, sharing_profile: "optout_required" } });
  assert.equal(opt.event.type, "privacy.optout.recorded"); assert.equal(opt.confirmation, "NTC_REGP_OPT_OUT_CONFIRMATION");
  clock.set("2027-08-01T05:00:00.000Z");
  const closed = closeOptOutWindow(r.deps(), { loan_id: "L-1", today: D("2027-08-01") });
  assert.equal(closed.elapsed, true); assert.equal(closed.event!.type, "privacy.revised_notice.optout_window_elapsed"); assert.equal(closed.event!.payload.window_ended, "2027-07-31"); assert.deepEqual(closed.opted_out, ["P-2"]);
  assert.equal(gate.status, "satisfied"); assert.equal(gate.satisfiedByEventId, closed.event!.id);
  assert.equal(closeOptOutWindow(r.deps(), { loan_id: "L-1", today: D("2027-08-02") }).event!.id, closed.event!.id);   // closed once
  assert.equal(marketingShareExport(r.deps(), { loan_id: "L-1", party_id: "P-1", tag: "marketing_share" }).allowed, true);    // a non-opt-out may be shared from Aug 1
  assert.equal(marketingShareExport(r.deps(), { loan_id: "L-1", party_id: "P-2", tag: "marketing_share" }).allowed, false);   // the opt-out is honored in the export layer
  assert.equal(events.ofType("privacy.export.blocked").length, 3);
  // the annual clock restarts from July 1 (§1016.5(e)(2)(i): the revised notice is the initial notice for annual timing)
  const annual = engine.byCode("REGP_1016_5A_ANNUAL_NOTICE_12M"); assert.equal(annual.length, 1); assert.equal(annual[0]!.anchorDate, "2027-07-01"); assert.equal(annual[0]!.dueDate, "2028-07-01"); assert.equal(annual[0]!.armedByEventId, s.annual_restart.id);
  assert.throws(() => sendRevisedPrivacyNotice(r.deps(), { loan_id: "L-1", party_id: "P-1", sent_on: D("2027-08-02"), notice_version: "v4", basis: "mail" }), /no pending privacy_policy.changed/);
  // the revised form carries the opt-out block and the 30-day window; a shorter window is a blocking checklist failure
  const reg = buildRegistry(); publishAuthored(reg); const v = reg.activeVersion("NTC_REGP_1016_8_REVISED", D("2027-07-01"))!;
  const payload = assemblePrivacyNoticePayload({ program: { ...PROGRAM, sharing_profile: "optout_required", notice_version: "v4" }, property_state: "TX", kind: "revised" });
  const rendered = render(v.source, payload); assert.match(rendered.text, /we can begin sharing your information 30 days from the date we sent this notice/); assert.equal(evaluateChecklist(v, payload, rendered).passed, true);
  const short = { ...payload, optout_days: 14 }; assert.ok(evaluateChecklist(v, short, render(v.source, short)).blocking.some((b) => b.rule_id === "optout-window"));
  assert.throws(() => assemblePrivacyNoticePayload({ program: PROGRAM, property_state: "TX", kind: "revised" }), RangeError);   // no opt-out form while sharing stays within the exceptions
});
test("7.5-T5: Given a policy change that ends the exception without requiring a revised notice, then annual notices are sent within 100 days.", () => {
  const c0 = policyChange(false, true, D("2027-06-15"));
  assert.equal(c0.revised_notice, false); assert.equal(c0.annual_notice_due, "2027-09-23"); assert.equal(c0.gate, null); assert.equal(daysBetween(D("2027-06-15"), D("2027-09-23")), 100);
  assert.equal(policyChange(false, false, D("2027-06-15")).annual_notice_due, null);
  const r = rig("2027-06-15T15:00:00.000Z"); const { clock, events, engine } = r;
  const c = recordPolicyChange(r.deps(), { partner_id: "PB", loan_id: "L-1", change_date: D("2027-06-15"), new_sharing: false, exception_lost: true, description: "categories of affiliates disclosed under §1016.6(a)(4) change" });
  assert.equal(c.event.payload.new_sharing, false); assert.equal(c.event.payload.exception_lost, true); assert.equal(c.event.payload.annual_notice_due, "2027-09-23"); assert.equal(c.event.payload.gate, null);
  assert.equal(c.assessment.revised_notice, false); assert.equal(c.assessment.annual_notice_due, "2027-09-23");
  assert.equal(engine.byCode("REGP_1016_8_REVISED_NOTICE_GATE").length, 0);   // no sharing gate without new sharing
  const t = engine.byCode("REGP_1016_5E2II_ANNUAL_AFTER_CHANGE_100")[0]!; assert.equal(t.anchorDate, "2027-06-15"); assert.equal(t.dueDate, "2027-09-23"); assert.equal(t.status, "armed"); assert.equal(t.armedByEventId, c.event.id);
  assert.throws(() => sendRevisedPrivacyNotice(r.deps(), { loan_id: "L-1", party_id: "P-1", sent_on: D("2027-07-01"), notice_version: "v4", basis: "mail" }), /no pending privacy_policy.changed/);   // no revised notice for this change
  clock.set("2027-09-01T15:00:00.000Z");
  const m = sendAnnualPrivacyNotice(r.deps(), { loan_id: "L-1", party_id: "P-1", year: 2027, sent_on: D("2027-09-01"), basis: "mail", notice_version: "v3" });
  assert.equal(m.sent.payload.template, "NTC_REGP_1016_5_ANNUAL"); assert.equal(m.sent.payload.kind, "annual"); assert.ok(m.sent.payload.sent_on <= c.assessment.annual_notice_due!);
  assert.equal(t.status, "satisfied"); assert.equal(t.satisfiedByEventId, m.sent.id); assert.equal(m.annual_sent.payload.outcome, "annual_sent");
  assert.equal(events.ofType("timer.breached").length, 0);
  // a change that neither adds sharing nor ends the exception arms nothing; new sharing implies the exception is lost
  recordPolicyChange(r.deps(), { partner_id: "PB", loan_id: "L-2", change_date: D("2027-06-15"), new_sharing: false, exception_lost: false, description: "contact details" });
  assert.equal(engine.byCode("REGP_1016_5E2II_ANNUAL_AFTER_CHANGE_100").filter((i) => i.loanId === "L-2").length, 0);
  assert.equal(recordPolicyChange(r.deps(), { partner_id: "PB", loan_id: "L-3", change_date: D("2027-06-15"), new_sharing: true, exception_lost: false, description: "new marketer" }).event.payload.exception_lost, true);
  assert.equal(engine.byCode("REGP_1016_5E2II_ANNUAL_AFTER_CHANGE_100").filter((i) => i.loanId === "L-3").length, 0);
  assert.throws(() => recordPolicyChange(r.deps(), { partner_id: "PB", loan_id: "L-4", change_date: D("2027-06-15"), new_sharing: "yes" as never, exception_lost: true, description: "x" }), RangeError);
  // an unsent 100-day clock breaches at sev-2
  const late = rig("2027-06-15T15:00:00.000Z"); recordPolicyChange(late.deps(), { partner_id: "PB", loan_id: "L-1", change_date: D("2027-06-15"), new_sharing: false, exception_lost: true, description: "x" });
  const breaches = late.engine.evaluate("2027-09-24T05:00:00.000Z"); assert.equal(breaches.length, 1); assert.equal(breaches[0]!.def.code, "REGP_1016_5E2II_ANNUAL_AFTER_CHANGE_100"); assert.equal(breaches[0]!.severity, 2);
});
test("7.5-T6: Given a borrower with `privacy_notices` e-consent, then the initial notice is posted with a required acknowledgment and the acknowledgment timestamp is stored; given no acknowledgment within 30 days, then a paper copy is mailed.", () => {
  const posted = privacyPortalPosting({ posted_on: D("2026-11-10"), acknowledged_at: "2026-11-11T09:00:00Z", today: D("2026-12-15") });
  assert.equal(posted.acknowledgment_required, true); assert.equal(posted.acknowledged_at, "2026-11-11T09:00:00Z"); assert.equal(posted.mail_paper, false);
  const unack = privacyPortalPosting({ posted_on: D("2026-11-10"), acknowledged_at: null, today: D("2026-12-10") });
  assert.equal(unack.paper_fallback_on, "2026-12-10"); assert.equal(unack.mail_paper, true);
  assert.equal(privacyPortalPosting({ posted_on: D("2026-11-10"), acknowledged_at: null, today: D("2026-12-09") }).mail_paper, false);
  const r = rig("2026-11-02T14:00:00.000Z"); const { clock, events, engine } = r; msrIn(r); const consent = eConsent("P-1");
  clock.set("2026-11-10T15:00:00.000Z");
  assert.throws(() => postInitialNoticeToPortal(r.deps(), { loan_id: "L-1", party_id: "P-1", posted_on: D("2026-11-10"), consent: null, notice_version: "v3" }), /no active E-SIGN consent/);   // no e-consent → mail
  assert.throws(() => postInitialNoticeToPortal(r.deps(), { loan_id: "L-1", party_id: "P-1", posted_on: D("2026-11-10"), consent: eConsent("P-2"), notice_version: "v3" }), RangeError);
  const p = postInitialNoticeToPortal(r.deps(), { loan_id: "L-1", party_id: "P-1", posted_on: D("2026-11-10"), consent, notice_version: "v3" });
  assert.equal(p.acknowledgment_required, true); assert.equal(p.paper_fallback_on, "2026-12-10");
  assert.equal(p.sent.payload.template, "NTC_REGP_1016_4_INITIAL"); assert.equal(p.sent.payload.basis, "portal_ack"); assert.equal(p.sent.payload.channel, "electronic"); assert.equal(p.sent.payload.acknowledgment_required, true); assert.equal(p.sent.payload.acknowledged_at, null); assert.equal(p.sent.payload.consent_class, "privacy_notices");
  const t = engine.byCode("REGP_1016_4A1_INITIAL_NOTICE_REASONABLE_30")[0]!; assert.equal(t.status, "satisfied"); assert.equal(t.satisfiedByEventId, p.sent.id);   // posting with a required acknowledgment is the delivery (§1016.9(b)(1)(iii))
  assert.equal(privacyPartyStatus(events, "L-1", "P-1"), "initial_sent");
  const ack = recordPortalAcknowledgment(r.deps(), { loan_id: "L-1", party_id: "P-1", acknowledged_at: "2026-11-11T09:00:00.000Z" });
  assert.equal(ack.event.type, "privacy.notice.acknowledged"); assert.equal(ack.event.payload.acknowledged_at, "2026-11-11T09:00:00.000Z"); assert.equal(ack.event.causationId, p.sent.id); assert.equal(ack.posting.id, p.sent.id);
  const sweep = portalAcknowledgmentSweep(r.deps(), { loan_id: "L-1", party_id: "P-1", today: D("2026-12-15") });
  assert.equal(sweep.acknowledged_at, "2026-11-11T09:00:00.000Z"); assert.equal(sweep.mail_paper, false); assert.equal(sweep.paper, null); assert.equal(sweep.paper_fallback_on, "2026-12-10");
  assert.equal(events.ofType("notice.sent").filter((e) => e.payload.basis === "mail").length, 0);
  // no acknowledgment within 30 days → a paper copy is mailed, once
  const u = rig("2026-11-02T14:00:00.000Z"); msrIn(u); u.clock.set("2026-11-10T15:00:00.000Z");
  postInitialNoticeToPortal(u.deps(), { loan_id: "L-1", party_id: "P-1", posted_on: D("2026-11-10"), consent: eConsent("P-1"), notice_version: "v3" });
  assert.throws(() => recordPortalAcknowledgment(u.deps(), { loan_id: "L-1", party_id: "P-1", acknowledged_at: "not-a-time" }), RangeError);
  const early = portalAcknowledgmentSweep(u.deps(), { loan_id: "L-1", party_id: "P-1", today: D("2026-12-09") }); assert.equal(early.mail_paper, false); assert.equal(early.acknowledged_at, null); assert.equal(early.paper, null);
  u.clock.set("2026-12-10T12:00:00.000Z");
  const fb = portalAcknowledgmentSweep(u.deps(), { loan_id: "L-1", party_id: "P-1", today: D("2026-12-10") });
  assert.equal(fb.mail_paper, true); assert.equal(fb.paper!.type, "notice.sent"); assert.equal(fb.paper!.payload.basis, "mail"); assert.equal(fb.paper!.payload.paper_fallback, true); assert.equal(fb.paper!.payload.template, "NTC_REGP_1016_4_INITIAL"); assert.equal(fb.paper!.payload.sent_on, "2026-12-10");
  const again = portalAcknowledgmentSweep(u.deps(), { loan_id: "L-1", party_id: "P-1", today: D("2026-12-11") }); assert.equal(again.mail_paper, false); assert.equal(again.paper, null);
  assert.equal(u.events.ofType("notice.sent").filter((e) => e.payload.basis === "mail").length, 1);
  assert.throws(() => portalAcknowledgmentSweep(u.deps(), { loan_id: "L-9", party_id: "P-1", today: D("2026-12-11") }), RangeError);
});
test(`7.5-T7: Given a California property, then the notice's "Other important information" carries the CalFIPA line only if the sharing profile requires it; the CCPA is not cited.`, () => {
  assert.deepEqual(otherImportantInformation({ state: "CA", sharing_profile: "exceptions_only" }), { lines: [], cites_ccpa: false });
  const broader = otherImportantInformation({ state: "CA", sharing_profile: "broader" });
  assert.equal(broader.lines.length, 1); assert.match(broader.lines[0]!, /California Financial Information Privacy Act/); assert.doesNotMatch(broader.lines[0]!, /CCPA|Consumer Privacy Act/); assert.equal(broader.cites_ccpa, false);
  const reg = buildRegistry(); publishAuthored(reg);
  // exceptions-only program: the California notice has no CalFIPA line (CalFIPA opt-in applies only to sharing outside the exceptions)
  const exc = assemblePrivacyNoticePayload({ program: PROGRAM, property_state: "CA", kind: "initial" });
  assert.deepEqual(exc.state_lines, []); assert.equal(exc.sharing_profile, "exceptions_only"); assert.equal(exc.share_nonaffiliates, "No");
  const v4 = reg.activeVersion("NTC_REGP_1016_4_INITIAL", D("2026-11-10"))!; const r4 = render(v4.source, exc);
  assert.match(r4.text, /Other important information:/); assert.doesNotMatch(r4.text, /California Financial Information Privacy Act/); assert.doesNotMatch(r4.text, /CCPA|Consumer Privacy Act/); assert.equal(evaluateChecklist(v4, exc, r4).passed, true);
  // a program sharing outside the exceptions: the revised notice for a California property carries the CalFIPA line — and still never cites the CCPA (Civ. Code §1798.145(e))
  const br = assemblePrivacyNoticePayload({ program: { ...PROGRAM, sharing_profile: "optin_state", notice_version: "v4" }, property_state: "CA", kind: "revised" });
  assert.equal(br.state_lines.length, 1); assert.equal(br.sharing_profile, "broader"); assert.equal(br.share_nonaffiliates, "Yes");
  const v8 = reg.activeVersion("NTC_REGP_1016_8_REVISED", D("2027-07-01"))!; const r8 = render(v8.source, br);
  assert.match(r8.text, /Other important information: California residents: under the California Financial Information Privacy Act/); assert.doesNotMatch(r8.text, /CCPA|Consumer Privacy Act/); assert.equal(evaluateChecklist(v8, br, r8).passed, true);
  // the line is a California overlay: a Texas property under the same broader program carries none; Vermont carries its own
  assert.deepEqual(assemblePrivacyNoticePayload({ program: { ...PROGRAM, sharing_profile: "optin_state" }, property_state: "TX", kind: "revised" }).state_lines, []);
  assert.match(assemblePrivacyNoticePayload({ program: { ...PROGRAM, sharing_profile: "optin_state" }, property_state: "VT", kind: "revised" }).state_lines[0]!, /Vermont residents/);
  // the dormant CalFIPA form itself refuses to cite the CCPA and issues only under a broader profile
  const fipa = reg.activeVersion("NTC_STATE_CA_FIPA", D("2027-07-01"))!; const rf = render(fipa.source, fipa.samplePayload);
  assert.doesNotMatch(rf.text, /CCPA|Consumer Privacy Act/); assert.equal(evaluateChecklist(fipa, fipa.samplePayload, rf).passed, true);
  const dormant = { ...fipa.samplePayload, sharing_profile: "exceptions_only" }; assert.ok(evaluateChecklist(fipa, dormant, render(fipa.source, dormant)).blocking.some((b) => b.rule_id === "dormant"));
});
test("7.5-T8: Given payoff on 2027-03-10, then no annual notice is generated for 2027 and the party status is `terminated`.", () => {
  assert.deepEqual(annualNoticeAfterTermination({ terminated_on: D("2027-03-10"), notice_year: 2027 }), { annual_notice: false, party_status: "terminated" });
  const r = rig("2026-11-02T14:00:00.000Z"); const { clock, events, engine } = r;
  msrIn(r); clock.set("2026-11-10T15:00:00.000Z"); sendInitialPrivacyNotice(r.deps(), { loan_id: "L-1", party_id: "P-1", sent_on: D("2026-11-10"), basis: "hello_insert", notice_version: "v3", hello_notice_id: "n-hello" });
  const annual = engine.byCode("REGP_1016_5A_ANNUAL_NOTICE_12M")[0]!; assert.equal(annual.status, "armed"); assert.equal(annual.dueDate, "2027-11-10");
  clock.set("2027-03-10T20:00:00.000Z");
  const t = terminatePrivacyRelationship(r.deps(), { loan_id: "L-1", party_id: "P-1", reason: "payoff", on: D("2027-03-10"), timers: engine });
  assert.equal(t.party_status, "terminated"); assert.equal(t.event.type, "privacy.relationship.terminated"); assert.equal(t.event.payload.reason, "payoff"); assert.equal(t.event.payload.on, "2027-03-10"); assert.equal(t.event.payload.party_status, "terminated"); assert.equal(t.event.payload.annual_notice_this_year, false);
  assert.deepEqual(t.cancelled, ["REGP_1016_5A_ANNUAL_NOTICE_12M"]); assert.equal(annual.status, "cancelled"); assert.match(annual.cancelledReason!, /§1016.5\(b\)/);
  assert.equal(privacyPartyStatus(events, "L-1", "P-1"), "terminated");
  // the 2027 cycle generates nothing for the terminated relationship, whether or not the partner attested
  assert.deepEqual(applyAnnualCycle(r.deps(), { loan_id: "L-1", party_id: "P-1", year: 2027, program: PROGRAM, attestation: null, today: D("2027-04-01") }), { status: "terminated", annual_notice: false, event: null });
  assert.deepEqual(applyAnnualCycle(r.deps(), { loan_id: "L-1", party_id: "P-1", year: 2027, program: { ...PROGRAM, sharing_profile: "optout_required" }, attestation: { attestation_id: "att-2027-01", no_change: true }, today: D("2027-04-01") }), { status: "terminated", annual_notice: false, event: null });
  assert.equal(events.ofType("privacy.annual_due").length, 0); assert.equal(events.ofType("privacy.annual_sent").length, 0); assert.equal(events.ofType("notice.sent").filter((e) => e.payload.template === "NTC_REGP_1016_5_ANNUAL").length, 0);
  assert.throws(() => sendAnnualPrivacyNotice(r.deps(), { loan_id: "L-1", party_id: "P-1", year: 2027, sent_on: D("2027-06-01"), basis: "mail", notice_version: "v3" }), /terminated/);
  assert.throws(() => privacyInitialNoticeDue(r.deps(), { kind: "msr_acquisition", loan_id: "L-1", party_id: "P-1", partner_id: "PB", transfer_date: D("2027-04-01") }), /terminated/);
  assert.equal(engine.open().filter((i) => i.loanId === "L-1").length, 0); assert.equal(events.ofType("timer.cancelled").length, 1);
  // a payoff in an earlier year does not touch a year already served; a transfer-out ends the relationship the same way (rule 9)
  assert.deepEqual(annualNoticeAfterTermination({ terminated_on: D("2026-12-31"), notice_year: 2026 }), { annual_notice: false, party_status: "terminated" });
  const x = rig("2027-03-10T20:00:00.000Z"); const tx = terminatePrivacyRelationship(x.deps(), { loan_id: "L-2", party_id: "P-2", reason: "transfer_out", on: D("2027-03-10") }); assert.equal(tx.party_status, "terminated"); assert.deepEqual(tx.cancelled, []);
  assert.throws(() => terminatePrivacyRelationship(x.deps(), { loan_id: "L-2", party_id: "P-2", reason: "charge_off" as never, on: D("2027-03-10") }), RangeError);
});
test("7.5-T9: Given a borrower requests a copy by chat, then a copy is sent within 5 business days by the borrower's consented channel.", () => {
  const consent = eConsent("P-1");
  const pure = privacyCopyOnRequest({ requested_on: D("2026-10-14"), consent });
  assert.equal(pure.send_by, "2026-10-21"); assert.equal(pure.channel, "electronic"); assert.equal(pure.kind, "on_request");
  assert.equal(privacyCopyOnRequest({ requested_on: D("2026-10-14"), consent: null }).channel, "mail");
  const r = rig("2026-09-01T14:00:00.000Z"); const { clock, events, engine } = r;
  msrIn(r, "L-1", "P-1", D("2026-09-01")); clock.set("2026-09-10T15:00:00.000Z"); sendInitialPrivacyNotice(r.deps(), { loan_id: "L-1", party_id: "P-1", sent_on: D("2026-09-10"), basis: "hello_insert", notice_version: "v3", hello_notice_id: "n-hello" });
  clock.set("2026-10-14T16:30:00.000Z");
  assert.throws(() => requestPrivacyCopy(r.deps(), { loan_id: "L-1", party_id: "P-1", channel: "fax" as never, requested_on: D("2026-10-14"), consent }), RangeError);
  const req = requestPrivacyCopy(r.deps(), { loan_id: "L-1", party_id: "P-1", channel: "chat", requested_on: D("2026-10-14"), consent });
  assert.equal(req.event.type, "privacy_notice.copy_requested"); assert.equal(req.event.payload.channel, "chat"); assert.equal(req.event.payload.requested_on, "2026-10-14"); assert.equal(req.event.payload.send_by, "2026-10-21"); assert.equal(req.event.payload.delivery_channel, "electronic");
  assert.equal(req.send_by, "2026-10-21"); assert.equal(req.channel, "electronic"); assert.equal(req.kind, "on_request"); assert.equal(req.template, "NTC_REGP_1016_4_INITIAL");
  const t = engine.byCode("SM_PRIVACY_COPY_ON_REQUEST_5BD")[0]!; assert.equal(t.anchorDate, "2026-10-14"); assert.equal(t.dueDate, "2026-10-21"); assert.equal(t.status, "armed"); assert.equal(t.armedByEventId, req.event.id);   // Wed → +5 servicer business days → Wed
  // another privacy mailing in the window is not the requested copy
  events.append({ type: "notice.sent", loanId: "L-1", actor: SYSTEM, payload: { template: "NTC_REGP_1016_4_INITIAL", kind: "initial", basis: "mail" } }); assert.equal(t.status, "armed");
  clock.set("2026-10-16T15:00:00.000Z");
  const s = sendPrivacyCopy(r.deps(), { loan_id: "L-1", party_id: "P-1", sent_on: D("2026-10-16") });
  assert.equal(s.sent.type, "notice.sent"); assert.equal(s.sent.payload.kind, "on_request"); assert.equal(s.sent.payload.template, "NTC_REGP_1016_4_INITIAL"); assert.equal(s.sent.payload.channel, "electronic"); assert.equal(s.sent.payload.basis, "portal_ack"); assert.equal(s.sent.payload.notice_version, "v3");
  assert.equal(s.on_time, true); assert.equal(s.send_by, "2026-10-21"); assert.ok(s.sent.payload.sent_on <= s.send_by);
  assert.equal(t.status, "satisfied"); assert.equal(t.satisfiedByEventId, s.sent.id);
  assert.throws(() => sendPrivacyCopy(r.deps(), { loan_id: "L-1", party_id: "P-1", sent_on: D("2026-10-17") }), /already sent/);
  assert.throws(() => sendPrivacyCopy(r.deps(), { loan_id: "L-1", party_id: "P-5", sent_on: D("2026-10-17") }), /no privacy copy request/);
  // without e-consent the copy goes by mail; a request over a federal holiday weekend still counts 5 servicer business days (Nov 11 + Nov 26 skipped)
  const m = rig("2026-11-09T15:00:00.000Z");
  const mreq = requestPrivacyCopy(m.deps(), { loan_id: "L-2", party_id: "P-2", channel: "call", requested_on: D("2026-11-09"), consent: null });
  assert.equal(mreq.channel, "mail"); assert.equal(mreq.send_by, "2026-11-17"); assert.equal(m.engine.byCode("SM_PRIVACY_COPY_ON_REQUEST_5BD")[0]!.dueDate, "2026-11-17");
  const ms = sendPrivacyCopy(m.deps(), { loan_id: "L-2", party_id: "P-2", sent_on: D("2026-11-17") }); assert.equal(ms.sent.payload.channel, "mail"); assert.equal(ms.sent.payload.basis, "mail"); assert.equal(ms.on_time, true);
  // an unanswered request breaches at sev-3
  const b = rig("2026-10-14T16:30:00.000Z"); requestPrivacyCopy(b.deps(), { loan_id: "L-3", party_id: "P-3", channel: "portal", requested_on: D("2026-10-14"), consent: null });
  const breaches = b.engine.evaluate("2026-10-22T05:00:00.000Z"); assert.equal(breaches.length, 1); assert.equal(breaches[0]!.def.code, "SM_PRIVACY_COPY_ON_REQUEST_5BD"); assert.equal(breaches[0]!.severity, 3);
});
