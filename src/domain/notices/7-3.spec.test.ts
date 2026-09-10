// 7.3 ARM initial adjustment notice
// spec/sections/07-compliance-notices-disclosures/7-3-arm-initial-adjustment-notice.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, daysBetween } from "../../kernel/calendar/date.ts";
import { zonedEpochMs, toIso } from "../../kernel/calendar/zoned.ts";
import { MemoryEventStore, FixedClock, SYSTEM, eventMatches, parseEventPattern, type Actor } from "../../kernel/events/index.ts";
import { TimerEngine } from "../../kernel/timers/engine.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { NoticeService } from "../../notices/service.ts";
import { FakePrintMail, FakeEdelivery } from "../../infra/integrations/delivery.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist, publishCheck } from "../../notices/checklist.ts";
import { planEnvelopes, type Recipient } from "../../notices/channel.ts";
import { VERSIONS_7_3 } from "../../notices/authored/section7-3.ts";
import { newRate, newPayment, initialNoticeWindow, sendCheck, indexFreshForInitial } from "./arm.ts";
import { initialNoticeIndexHold, transferInInitialNotice, composeEnvelope, stateHfaContact, correctedInitialNotice, scheduledUpbAfter } from "./ops.ts";
import * as A from "./ops-7-2.ts";
import * as O from "./ops-7-3.ts";

// ---- rig: event store + TimerEngine (7.3 rows) + entity store + Notice Registry service with fake delivery ports ----
class MemStore implements A.CaseStore {
  private readonly rows = new Map<string, { id: string; data: Record<string, unknown> }>();
  get(kind: string, id: string) { return this.rows.get(`${kind} ${id}`); }
  list(kind: string, where: (d: Record<string, unknown>) => boolean = () => true) { return [...this.rows.entries()].filter(([k, r]) => k.startsWith(`${kind} `) && where(r.data)).map(([, r]) => r); }
  put(kind: string, id: string, data: Record<string, unknown>) { const prev = this.get(kind, id); const r = { id, data: { ...(prev?.data ?? {}), ...data } }; this.rows.set(`${kind} ${id}`, r); return r; }
}
const DISCLOSURES: Actor = { kind: "agent", id: "disclosures" };
const ET = "America/New_York";
const CONTACT = { servicer_phone: "(800) 555-0100", servicer_address: "PO Box 1, Testville TX 75001", exclusive_address: "PO Box 2, Testville TX 75001" };
const BORROWER: Recipient = { partyId: "B-1", name: "Alex Borrower", mailingAddress: "1 Test St, Testville TX 75001" };
const HFA = { TX: { hfa_name: "Texas Department of Housing and Community Affairs", hfa_phone: "(800) 792-1119" }, CA: { hfa_name: "California Housing Finance Agency", hfa_phone: "(877) 922-5432" } };
const TIMERS = { gate: "REGZ_1026_20D_INITIAL_NOTICE_NOT_BEFORE_240", deadline: "REGZ_1026_20D_INITIAL_NOTICE_210" };
const SEND = { recipients: [BORROWER], contact: CONTACT, property_state: "TX", hfa_rules: HFA };
// Plan 4927 worked example (same loan as 7.2): note 5.750%, margin 2.750, $400,000.00, 360 months, first payment 2021-12-01, first change 2026-11-01 → first new payment due 2026-12-01.
const LOAN = "L-4927";
const PLAN_4927 = { loan_id: LOAN, product: "ARM", fnma_arm_plan: "4927", index_type: "SOFR_30D_AVG", margin_pct: "2.750", lookback_days: 45, first_change_date: "2026-11-01", adjustment_period_months: 6, initial_cap_pct: "2.000", periodic_cap_pct: "1.000", lifetime_cap_pct: "5.000", initial_note_rate_pct: "5.750", current_pi_cents: 233429n, original_upb_cents: 40000000n, first_payment_due: "2021-12-01", term_months: 360, consummation_date: "2021-11-15", escrow_cents: 61250n } as const;
const nyfed = (effectiveDate: string, average30day: string) => ({ effectiveDate, type: "SOFRAI", average30day, average90day: "3.70000", average180day: "3.90000", index: "1.12000000", revisionIndicator: "" });
function rig(day: string, hhmm = "14:00") {
  const clock = new FixedClock(toIso(zonedEpochMs(D(day), hhmm, ET))); const events = new MemoryEventStore(clock);
  const engine = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["7.3"] });
  const store = new MemStore(); const reg = buildRegistry(); publishAuthored(reg);
  // The spec's worked example (April–June 2026) predates the catalog's go-live effective dates (2026-09-01..03); the
  // fixture publishes the 7.3-authored 1.2.0 content of NTC_REGZ_20D_ARM_INITIAL effective for the scenario dates.
  for (const v of VERSIONS_7_3) { reg.draft({ ...v, version: `${v.version}-fixture`, effectiveFrom: D("2026-01-01"), effectiveTo: D("2026-09-02") }); reg.publish(v.templateCode, `${v.version}-fixture`, "counsel", "2026-01-01T00:00:00.000Z", publishCheck); }
  const pm = new FakePrintMail(); const ed = new FakeEdelivery();
  const notices = new NoticeService({ registry: reg, events, clock, printMail: pm, edelivery: ed });
  const deps = (): A.OpsDeps => ({ events, store, actor: DISCLOSURES, now: clock.now() });
  const at = (d: string, h = "14:00"): void => clock.set(toIso(zonedEpochMs(D(d), h, ET)));
  const status = (code: string, n = 0) => engine.byCode(code)[n]?.status ?? "not armed";
  const sentTemplates = (loanId: string) => events.byLoan(loanId).filter((e) => e.type === "notice.sent").map((e) => String(e.payload.template));
  const board = (day: string, terms: Record<string, unknown> = { ...PLAN_4927 }) => { at(day); const b = A.boardArmTerms(deps(), terms); const fc = O.openInitialFileCheck(deps(), { loan_id: String(terms.loan_id), boarded_on: D(day) }); return { ...b, fc }; };
  return { clock, events, engine, store, reg, notices, pm, ed, deps, at, status, sentTemplates, board };
}

test("7.3-T1: Given first new payment due 2026-12-01, then the window is 2026-04-05..2026-05-05; a send on 2026-04-04 is blocked; a send on 2026-05-06 breaches.", async () => {
  const w = initialNoticeWindow(D("2026-12-01"), D("2021-11-15"), 360);
  assert.deepEqual([w.status, w.not_before, w.deadline, w.send_target], ["servicer", "2026-04-05", "2026-05-05", "2026-04-10"]);
  assert.deepEqual(O.initialNoticeDates(D("2026-12-01")), { window_open: D("2026-04-05"), send_target: D("2026-04-10"), deadline: D("2026-05-05") });
  assert.deepEqual(sendCheck(D("2026-04-04"), w, TIMERS), { allowed: false, blocked_by: "REGZ_1026_20D_INITIAL_NOTICE_NOT_BEFORE_240", breach: null });
  assert.deepEqual(sendCheck(D("2026-04-21"), w, TIMERS), { allowed: true, blocked_by: null, breach: null });
  assert.deepEqual(sendCheck(D("2026-05-06"), w, TIMERS), { allowed: true, blocked_by: null, breach: { timer: "REGZ_1026_20D_INITIAL_NOTICE_210", severity: 1, days_late: 1 } });
  // through the process: the boarded schedule row (`arm.schedule.row_created{initial=true}`) arms the −240 gate and the −210 deadline on `first_new_payment_due`
  const r = rig("2026-01-15"); const { armed } = r.board("2026-01-15");
  assert.equal(armed!.event.payload.initial, true); assert.equal(armed!.event.payload.first_new_payment_due, "2026-12-01");
  const gate = r.engine.byCode(TIMERS.gate)[0]!; const dl = r.engine.byCode(TIMERS.deadline)[0]!;
  assert.equal(gate.dueDate, "2026-04-05"); assert.equal(dl.dueDate, "2026-05-05"); assert.equal(gate.status, "armed"); assert.equal(dl.status, "armed");
  assert.equal(O.determineInitialNoticeStatus(r.deps(), { loan_id: LOAN, on: D("2026-01-15"), transferor_evidence: null }).status, "scheduled");
  // 2026-04-04: the window has not opened — the estimate may be prepared but the send is blocked by the gate
  r.at("2026-04-03"); A.captureIndex(r.deps(), nyfed("2026-04-03", "3.64000"));
  r.at("2026-04-04"); assert.equal(O.openInitialNoticeWindow(r.deps(), LOAN).opened, false); assert.equal(r.status(TIMERS.gate), "armed");
  assert.equal(O.requestInitialNoticeRender(r.deps(), { loan_id: LOAN }).hold, false);
  await assert.rejects(O.sendInitialNotice(r.deps(), r.notices, { loan_id: LOAN, ...SEND }), /REGZ_1026_20D_INITIAL_NOTICE_NOT_BEFORE_240: send blocked before 2026-04-05/);
  assert.deepEqual(r.sentTemplates(LOAN), []);
  // 2026-04-05: `arm.initial_notice.window_opened` satisfies the gate
  r.at("2026-04-05"); const opened = O.openInitialNoticeWindow(r.deps(), LOAN);
  assert.equal(opened.opened, true); assert.equal(opened.event!.type, "arm.initial_notice.window_opened"); assert.equal(opened.event!.payload.opens_on, "2026-04-05"); assert.equal(opened.event!.payload.deadline, "2026-05-05");
  assert.equal(r.status(TIMERS.gate), "satisfied"); assert.equal(r.engine.byCode(TIMERS.gate)[0]!.satisfiedByEventId, opened.event!.id);
  // 2026-05-06: the deadline breached at end of day 05-05 (sev-1); the send still goes, recorded as the breach, and `arm.initial_notice.sent{satisfies_timer=true}` closes the clock late
  r.at("2026-05-06"); const breaches = r.engine.evaluate(r.clock.now());
  assert.equal(breaches.find((b) => b.def.code === TIMERS.deadline)!.severity, 1); assert.equal(r.status(TIMERS.deadline), "breached");
  A.captureIndex(r.deps(), nyfed("2026-05-05", "3.63500")); O.requestInitialNoticeRender(r.deps(), { loan_id: LOAN, disclosure_date: D("2026-05-06") });
  const late = await O.sendInitialNotice(r.deps(), r.notices, { loan_id: LOAN, ...SEND });
  assert.equal(late.late, true); assert.deepEqual(late.breach, { timer: "REGZ_1026_20D_INITIAL_NOTICE_210", severity: 1, days_late: 1 }); assert.equal(late.breach_attributable_to, "servicer"); assert.equal(late.days_before_first_payment, 209);
  assert.deepEqual(r.sentTemplates(LOAN), ["NTC_REGZ_20D_ARM_INITIAL"]); assert.equal(late.event.type, "arm.initial_notice.sent"); assert.equal(late.event.payload.satisfies_timer, true);
  assert.equal(r.status(TIMERS.deadline), "satisfied_late"); assert.equal(r.engine.byCode(TIMERS.deadline)[0]!.satisfiedByEventId, late.event.id);
  // the closing pattern is the spec's own event family; the window / render events never close the deadline
  const pat = loadOverriddenRegistry().get(TIMERS.deadline)!.satisfiedPattern!;
  assert.equal(eventMatches(pat, late.event), true); assert.equal(eventMatches(pat, opened.event!), false); assert.equal(eventMatches(pat, late.render_requested_event), false);
});
test('7.3-T2: Given disclosure date 2026-04-20 and index 3.64381 published 2026-04-20, then the estimate is 6.375% / $2,476.44, both labeled "estimate," with the 2–4-month follow-up sentence.', async () => {
  const est = newRate({ index_pct: "3.64381", margin_pct: "2.750", prior_rate_pct: "5.750", initial_note_rate_pct: "5.750", initial_cap_pct: "2.000", periodic_cap_pct: "1.000", lifetime_cap_pct: "5.000", first_change: true });
  assert.equal(est.unrounded_pct, "6.39381"); assert.equal(est.new_rate_pct, "6.375"); assert.equal(newPayment(37104886n, est.new_rate_pct, 300), 247644n);
  assert.equal(indexFreshForInitial({ effective_date: D("2026-04-20"), value: "3.64381" }, D("2026-04-20")), true);
  // through the process: the NY Fed print of April 20 is the estimate basis; engine A on the F-1-01 expected UPB ($371,048.86 at Nov 1, 2026) over 300 months
  const r = rig("2026-01-15"); r.board("2026-01-15"); O.determineInitialNoticeStatus(r.deps(), { loan_id: LOAN, transferor_evidence: null });
  r.at("2026-04-05"); O.openInitialNoticeWindow(r.deps(), LOAN);
  r.at("2026-04-20"); A.captureIndex(r.deps(), nyfed("2026-04-17", "3.64200")); A.captureIndex(r.deps(), nyfed("2026-04-20", "3.64381"));
  const rr = O.requestInitialNoticeRender(r.deps(), { loan_id: LOAN, disclosure_date: D("2026-04-20") });
  assert.equal(rr.hold, false); assert.equal(rr.basis, "estimate"); assert.equal(rr.index!.effective_date, "2026-04-20"); assert.equal(rr.index_age_business_days, 0);
  assert.equal(rr.estimate!.index_value, "3.64381"); assert.equal(rr.estimate!.unrounded_pct, "6.39381"); assert.equal(rr.estimate!.est_rate_pct, "6.375"); assert.equal(rr.estimate!.est_pi_cents, 247644n);
  assert.equal(rr.estimate!.expected_upb_cents, 37104886n); assert.equal(rr.estimate!.remaining_term_months, 300); assert.equal(rr.estimate!.is_estimate, true);
  assert.equal(r.store.list("arm_initial_estimates").length, 1); assert.equal(rr.event.type, "arm.initial_notice.render_requested"); assert.equal(evaluateGate("7.3.indexRecentEnoughForEstimate", rr.event.payload).open, true);
  // mailed April 21 (T−224): both figures labeled "(estimated)" and the follow-up sentence, through the Notice Registry (render → checklist → send)
  r.at("2026-04-21"); const s = await O.sendInitialNotice(r.deps(), r.notices, { loan_id: LOAN, ...SEND });
  assert.equal(s.sent_on, "2026-04-21"); assert.equal(s.days_before_first_payment, 224); assert.equal(s.late, false); assert.equal(s.basis, "estimate"); assert.equal(s.channel, "mail");
  const text = r.notices.get(s.notice_id).rendered.text;
  assert.match(text, /Date of this disclosure: April 20, 2026/);                                                            // (d)(2)(i)
  assert.match(text, /Estimated new rate 6\.375% \(estimated\) based on the 30-day Average SOFR published April 20, 2026 by the Federal Reserve Bank of New York \(newyorkfed\.org\) of 3\.64381 plus a margin of 2\.750%; estimated new payment \$2,476\.44 \(estimated\) versus your current payment \$2,334\.29/);
  assert.match(text, /your rate will change on November 1, 2026 and every six months thereafter; the first payment at the new rate is due December 1, 2026/);
  assert.match(text, /cannot increase or decrease by more than 2\.000% at this change, by more than 1\.000% at later changes, or ever exceed 10\.750%; it will never fall below 2\.750%/);
  assert.match(text, /The actual rate and payment will be sent between two and four months before December 1, 2026/);
  assert.equal(r.notices.get(s.notice_id).checklist.passed, true);
  for (const id of ["i-date", "iii-estimated", "iv-index-source", "follow-up", "index-recency", "timing-window"]) assert.equal(r.notices.get(s.notice_id).checklist.results.find((x) => x.rule_id === id)!.passed, true, id);
  assert.equal(s.event.payload.est_rate_pct, "6.375"); assert.equal(s.event.payload.est_pi_cents, 247644n); assert.equal(s.event.payload.basis, "estimate");
  assert.equal(r.store.list("arm_initial_estimates")[0]!.data.notice_id, s.notice_id); assert.equal(O.loadState(r.deps(), LOAN).status, "awaiting_actual");
  assert.equal(r.status(TIMERS.deadline), "satisfied");
  // the catalog's 1.2.0 version (estimate and actual variants): the actual variant carries no estimate label and no follow-up sentence
  const v = r.reg.activeVersion("NTC_REGZ_20D_ARM_INITIAL", D("2026-09-20"))!; assert.equal(v.version, "1.2.0");
  const c = evaluateChecklist(v, v.samplePayload, render(v.source, v.samplePayload)); assert.equal(c.passed, true);
  const actual = { ...v.samplePayload, is_estimate: false }; const ra = render(v.source, actual);
  assert.doesNotMatch(ra.text, /\(estimated\)/); assert.doesNotMatch(ra.text, /between two and four months/); assert.equal(evaluateChecklist(v, actual, ra).passed, true);
  const noDate = { ...v.samplePayload, disclosure_date: null }; assert.ok(evaluateChecklist(v, noDate, render(v.source, noDate)).blocking.some((b) => b.rule_id === "i-date"));
  const noSource = { ...v.samplePayload, index_source: "our records" }; assert.ok(evaluateChecklist(v, noSource, render(v.source, noSource)).blocking.some((b) => b.rule_id === "iv-index-source"));
});
test("7.3-T3: Given the latest index publication is 16 business days old, then rendering is held until a fresh value is captured.", async () => {
  const h = initialNoticeIndexHold({ latest: { effective_date: D("2026-03-27"), value: "3.60" }, disclosure_date: D("2026-04-20") });
  assert.equal(h.business_days_old, 16); assert.equal(h.hold, true); assert.match(h.reason!, /hold until a fresh value/);
  assert.equal(initialNoticeIndexHold({ latest: { effective_date: D("2026-04-20"), value: "3.64381" }, disclosure_date: D("2026-04-20") }).hold, false);
  // through the process: the render request arms REGZ_1026_20D_ESTIMATE_INDEX_15BD; its evaluator closes on a 16-business-day-old index → held, nothing sent
  const r = rig("2026-01-15"); r.board("2026-01-15"); O.determineInitialNoticeStatus(r.deps(), { loan_id: LOAN, transferor_evidence: null });
  r.at("2026-04-05"); O.openInitialNoticeWindow(r.deps(), LOAN);
  r.at("2026-04-20"); A.captureIndex(r.deps(), nyfed("2026-03-27", "3.60000"));
  const held = O.requestInitialNoticeRender(r.deps(), { loan_id: LOAN, disclosure_date: D("2026-04-20") });
  assert.equal(held.hold, true); assert.equal(held.index_age_business_days, 16); assert.match(held.reason!, /16 business days old .* hold until a fresh value is captured/); assert.equal(held.estimate, null);
  assert.equal(held.event.type, "arm.initial_notice.render_requested"); assert.equal(held.event.payload.index_age_business_days, 16); assert.equal(held.event.payload.hold, true);
  assert.equal(held.held_event!.type, "arm.initial_notice.render_held"); assert.equal(held.held_event!.payload.breach_action, "hold; refresh index");
  const gate = r.engine.byCode("REGZ_1026_20D_ESTIMATE_INDEX_15BD")[0]!;
  assert.equal(gate.status, "armed"); assert.equal(gate.note, "evaluator:7.3.indexRecentEnoughForEstimate"); assert.equal(gate.armedByEventId, held.event.id);
  assert.equal(evaluateGate("7.3.indexRecentEnoughForEstimate", held.event.payload).open, false); assert.match(evaluateGate("7.3.indexRecentEnoughForEstimate", held.event.payload).reason!, /16 > 15/);
  assert.equal(r.store.list("arm_initial_estimates").length, 0); assert.equal(O.loadState(r.deps(), LOAN).status, "held");
  await assert.rejects(O.sendInitialNotice(r.deps(), r.notices, { loan_id: LOAN, ...SEND }), /REGZ_1026_20D_ESTIMATE_INDEX_15BD: rendering is held — latest index publication is 16 business days old/);
  // a fresh capture (the April 20 print) re-requests the render: the gate opens and the estimate is prepared
  A.captureIndex(r.deps(), nyfed("2026-04-20", "3.64381"));
  const fresh = O.requestInitialNoticeRender(r.deps(), { loan_id: LOAN, disclosure_date: D("2026-04-20") });
  assert.equal(fresh.hold, false); assert.equal(fresh.index_age_business_days, 0); assert.equal(evaluateGate("7.3.indexRecentEnoughForEstimate", fresh.event.payload).open, true); assert.equal(fresh.estimate!.est_rate_pct, "6.375");
  assert.equal(r.engine.byCode("REGZ_1026_20D_ESTIMATE_INDEX_15BD").length, 2); assert.equal(r.engine.byCode("REGZ_1026_20D_ESTIMATE_INDEX_15BD")[1]!.armedByEventId, fresh.event.id);
  // exactly 15 business days old is fresh (April 20 − 15 servicer business days = March 30); no capture at all also holds
  assert.equal(initialNoticeIndexHold({ latest: { effective_date: D("2026-03-30"), value: "3.60" }, disclosure_date: D("2026-04-20") }).hold, false);
  const none = rig("2026-01-15"); none.board("2026-01-15"); none.at("2026-04-20");
  assert.match(O.requestInitialNoticeRender(none.deps(), { loan_id: LOAN, disclosure_date: D("2026-04-20") }).reason!, /no index publication/);
});
test("7.3-T4: Given a loan boarded 2026-06-01 (T−183) with a transferor (d) notice image dated 2026-04-15 in the file, then status = `transferor_evidenced` and no duplicate is sent.", async () => {
  const p = transferInInitialNotice({ boarded_on: D("2026-06-01"), first_new_payment_due: D("2026-12-01"), consummation: D("2021-11-01"), term_months: 360, transferor_evidence: { document_id: "doc-transferor-d", dated: D("2026-04-15") } });
  assert.equal(p.status, "transferor_evidenced"); assert.equal(p.duplicate, false); assert.equal(p.send_by, null); assert.equal(p.evidence_document_id, "doc-transferor-d"); assert.equal(p.breach_record, null);
  // through the process: `loan.boarded` → the file check (ARM within 300 days: 183) arms SM_ARM_INITIAL_FILE_CHECK_T0 (+5 servicer business days from the boarding date)
  const r = rig("2026-06-01"); const { fc } = r.board("2026-06-01");
  assert.equal(fc.applicable, true); assert.equal(fc.days_to_first_new_payment, 183); assert.equal(fc.within_300_days, true); assert.equal(fc.determine_by, "2026-06-08"); assert.equal(fc.timer, "SM_ARM_INITIAL_FILE_CHECK_T0");
  assert.equal(fc.event!.type, "arm.initial_notice.file_check_opened"); assert.equal(fc.event!.payload.boarded_on, "2026-06-01"); assert.equal(fc.event!.payload.within_300_days, true);
  const t0 = r.engine.byCode("SM_ARM_INITIAL_FILE_CHECK_T0")[0]!; assert.equal(t0.status, "armed"); assert.equal(t0.dueDate, "2026-06-08"); assert.equal(t0.anchorDate, "2026-06-01"); assert.equal(t0.armedByEventId, fc.event!.id);
  assert.equal(r.status(TIMERS.deadline), "armed"); assert.equal(r.engine.byCode(TIMERS.deadline)[0]!.dueDate, "2026-05-05");   // armed by the schedule row; the transferor's evidence closes it
  // the transferor's (d) notice image in the file → transferor_evidenced; `arm.initial_notice.status_determined` closes the file check, `…transferor_evidenced` the deadline
  r.at("2026-06-02"); const d = O.determineInitialNoticeStatus(r.deps(), { loan_id: LOAN, transferor_evidence: { document_id: "doc-transferor-d", dated: D("2026-04-15") } });
  assert.equal(d.status, "transferor_evidenced"); assert.equal(d.duplicate, false); assert.equal(d.send_by, null); assert.equal(d.evidence_document_id, "doc-transferor-d"); assert.equal(d.breach_record, null); assert.equal(d.satisfies_deadline, true);
  assert.deepEqual(d.events.map((e) => e.type), ["arm.initial_notice.status_determined", "arm.initial_notice.transferor_evidenced"]);
  assert.equal(d.events[0]!.payload.status, "transferor_evidenced"); assert.equal(d.events[1]!.payload.evidence_document_id, "doc-transferor-d"); assert.equal(d.events[1]!.payload.satisfies_timer, true); assert.equal(d.events[1]!.payload.transferor_late, false);
  assert.equal(r.status("SM_ARM_INITIAL_FILE_CHECK_T0"), "satisfied"); assert.equal(t0.satisfiedByEventId, d.events[0]!.id);
  assert.equal(r.status(TIMERS.deadline), "satisfied"); assert.equal(r.engine.byCode(TIMERS.deadline)[0]!.satisfiedByEventId, d.events[1]!.id);
  assert.equal(eventMatches(parseEventPattern("`arm.initial_notice.transferor_evidenced`")!, d.events[1]!), true);
  // no duplicate: the window / render / send paths refuse, nothing goes through the Notice Registry
  assert.equal(O.openInitialNoticeWindow(r.deps(), LOAN).opened, false); assert.match(O.openInitialNoticeWindow(r.deps(), LOAN).reason!, /no duplicate is sent/);
  assert.throws(() => O.requestInitialNoticeRender(r.deps(), { loan_id: LOAN }), /no \(d\) notice is due — the transferor's \(d\) notice is in the file \(doc-transferor-d\)/);
  await assert.rejects(O.sendInitialNotice(r.deps(), r.notices, { loan_id: LOAN, ...SEND }), /no duplicate is sent/);
  assert.deepEqual(r.sentTemplates(LOAN), []); assert.equal(r.pm.jobs.size, 0); assert.equal(O.loadState(r.deps(), LOAN).status, "transferor_evidenced");
  assert.equal((r.store.get("arm_schedule", A.rowId(LOAN, D("2026-11-01")))!.data as Record<string, unknown>).initial_notice_status, "transferor_evidenced");
  // the "transferor sent it" determination requires an attached document (guardrail); a fixed-rate boarding opens no file check
  assert.throws(() => O.determineInitialNoticeStatus(r.deps(), { loan_id: LOAN, transferor_evidence: { document_id: "", dated: D("2026-04-15") } }), /requires the transferor's \(d\) notice as an attached document/);
  const fixed = rig("2026-06-01"); fixed.store.put("loan_terms", "L-FIXED", { loan_id: "L-FIXED", product: "FIXED" });
  assert.deepEqual(O.openInitialFileCheck(fixed.deps(), { loan_id: "L-FIXED", boarded_on: D("2026-06-01") }), { applicable: false, within_300_days: false, days_to_first_new_payment: null, determine_by: null, timer: null, event: null });
  assert.equal(fixed.engine.byCode("SM_ARM_INITIAL_FILE_CHECK_T0").length, 0);
});
test("7.3-T5: Given the same boarding with no evidence, then the notice is sent within 5 business days and a transferor-breach record is created.", async () => {
  const p = transferInInitialNotice({ boarded_on: D("2026-06-01"), first_new_payment_due: D("2026-12-01"), consummation: D("2021-11-01"), term_months: 360, transferor_evidence: null });
  assert.equal(p.status, "send_now"); assert.equal(p.send_by, "2026-06-08"); assert.deepEqual(p.breach_record, { attributable_to: "transferor", window_deadline: "2026-05-05" });
  // through the process: no evidence → `late`, send by 2026-06-08 (Mon Jun 1 + 5 servicer business days), the breach record attributable to the transferor
  const r = rig("2026-06-01"); r.board("2026-06-01");
  r.engine.evaluate(r.clock.now()); assert.equal(r.status(TIMERS.deadline), "breached");   // the −210 deadline (05-05) had passed before boarding
  const d = O.determineInitialNoticeStatus(r.deps(), { loan_id: LOAN, transferor_evidence: null });
  assert.equal(d.status, "late"); assert.equal(d.send_by, "2026-06-08"); assert.equal(d.satisfies_deadline, false);
  assert.deepEqual(d.breach_record, { attributable_to: "transferor", window_deadline: "2026-05-05", boarded_on: "2026-06-01", days_after_deadline: 27, claim: "17.3/1.7 transferor claim" });
  assert.deepEqual(d.events.map((e) => e.type), ["arm.initial_notice.status_determined", "arm.initial_notice.late"]); assert.equal(d.events[1]!.payload.breach_source, "transferor"); assert.equal("satisfies_timer" in d.events[1]!.payload, false);
  assert.equal(r.status("SM_ARM_INITIAL_FILE_CHECK_T0"), "satisfied"); assert.equal(r.status(TIMERS.deadline), "breached");
  const rec = r.store.get("transferor_breach_records", `${LOAN}:arm_initial_notice`)!.data; assert.equal(rec.kind, "arm_initial_notice_late"); assert.equal(rec.attributable_to, "transferor"); assert.equal(rec.window_deadline, "2026-05-05");
  // the send: index captured the same day, rendered as a late notice (breach recorded on the notice), mailed 2026-06-02 ≤ 2026-06-08
  A.captureIndex(r.deps(), nyfed("2026-06-01", "3.62000")); const rr = O.requestInitialNoticeRender(r.deps(), { loan_id: LOAN }); assert.equal(rr.hold, false); assert.equal(rr.disclosure_date, "2026-06-01");
  r.at("2026-06-02"); const s = await O.sendInitialNotice(r.deps(), r.notices, { loan_id: LOAN, ...SEND });
  assert.equal(s.sent_on, "2026-06-02"); assert.ok(daysBetween(s.sent_on, d.send_by!) >= 0); assert.equal(s.late, true); assert.equal(s.breach_attributable_to, "transferor"); assert.deepEqual(s.breach, { timer: "REGZ_1026_20D_INITIAL_NOTICE_210", severity: 1, days_late: 28 }); assert.equal(s.days_before_first_payment, 182);
  assert.equal(s.payload.late_notice, true); assert.equal(s.payload.breach_attributable_to, "transferor"); assert.equal(r.notices.get(s.notice_id).checklist.results.find((x) => x.rule_id === "timing-window")!.skipped, true); assert.equal(r.notices.get(s.notice_id).checklist.results.find((x) => x.rule_id === "late-breach-recorded")!.passed, true);
  assert.deepEqual(r.sentTemplates(LOAN), ["NTC_REGZ_20D_ARM_INITIAL"]); assert.equal(r.status(TIMERS.deadline), "satisfied_late"); assert.equal(r.engine.byCode(TIMERS.deadline)[0]!.satisfiedByEventId, s.event.id);
  assert.equal(s.event.payload.breach_attributable_to, "transferor"); assert.equal(s.event.payload.late, true);
  // the file check breaches at sev-2 when nothing is determined within 5 business days
  const idle = rig("2026-06-01"); idle.board("2026-06-01"); idle.at("2026-06-09");
  const b = idle.engine.evaluate(idle.clock.now()).find((x) => x.def.code === "SM_ARM_INITIAL_FILE_CHECK_T0")!; assert.equal(b.severity, 2); assert.equal(idle.status("SM_ARM_INITIAL_FILE_CHECK_T0"), "breached");
  assert.equal(O.determineInitialNoticeStatus(idle.deps(), { loan_id: LOAN, transferor_evidence: null }).status, "late"); assert.equal(idle.status("SM_ARM_INITIAL_FILE_CHECK_T0"), "satisfied_late");
});
test("7.3-T6: Given an ARM with a 12-month term, then status = `exempt_short_term`.", async () => {
  assert.equal(initialNoticeWindow(D("2026-12-01"), D("2021-11-15"), 12).status, "exempt_short_term");
  assert.equal(initialNoticeWindow(D("2026-12-01"), D("2021-11-15"), 13).status, "servicer");
  assert.equal(initialNoticeWindow(D("2026-12-01"), D("2026-06-01"), 360).status, "originator_duty");   // first adjusted payment within 210 days of consummation
  // through the process: a 12-month ARM (first change at month 6) → exempt_short_term; the determination closes the file check and the (d) deadline, nothing renders
  const r = rig("2026-01-15");
  const short = { ...PLAN_4927, loan_id: "L-12M", term_months: 12, first_payment_due: "2026-02-01", consummation_date: "2025-12-20", first_change_date: "2026-07-01", original_upb_cents: 10000000n, current_pi_cents: 858700n };
  r.board("2026-01-15", short);
  const d = O.determineInitialNoticeStatus(r.deps(), { loan_id: "L-12M", transferor_evidence: null });
  assert.equal(d.status, "exempt_short_term"); assert.equal(d.satisfies_deadline, true); assert.deepEqual(d.events.map((e) => e.type), ["arm.initial_notice.status_determined", "arm.initial_notice.exempt_short_term"]);
  assert.equal(d.events[1]!.payload.cite, "12 CFR 1026.20(d)(1)(ii)"); assert.equal(d.events[1]!.payload.term_months, 12);
  assert.equal(r.status("SM_ARM_INITIAL_FILE_CHECK_T0"), "satisfied"); assert.equal(r.status(TIMERS.deadline), "satisfied");
  assert.throws(() => O.requestInitialNoticeRender(r.deps(), { loan_id: "L-12M" }), /terms of one year or less are exempt \(§1026\.20\(d\)\(1\)\(ii\)\)/);
  await assert.rejects(O.sendInitialNotice(r.deps(), r.notices, { loan_id: "L-12M", ...SEND }), /exempt/); assert.deepEqual(r.sentTemplates("L-12M"), []);
  // originator duty (first adjusted payment ≤ 210 days from consummation): the consummation (d) disclosure in the file closes the deadline; without it the determination holds
  const o = rig("2026-06-15");
  const orig = { ...PLAN_4927, loan_id: "L-ORIG", first_payment_due: "2026-08-01", consummation_date: "2026-06-10", first_change_date: "2026-12-01", term_months: 360 };
  o.board("2026-06-15", orig);
  const held = O.determineInitialNoticeStatus(o.deps(), { loan_id: "L-ORIG", transferor_evidence: null });
  assert.equal(held.status, "originator_duty"); assert.equal(held.satisfies_deadline, false); assert.equal(held.events[1]!.payload.hold, "verify the consummation (d) disclosure in the file (rule 1)"); assert.equal(o.status(TIMERS.deadline), "armed");
  const ver = O.determineInitialNoticeStatus(o.deps(), { loan_id: "L-ORIG", transferor_evidence: null, consummation_disclosure_document_id: "doc-consummation-d" });
  assert.equal(ver.satisfies_deadline, true); assert.equal(ver.events[1]!.payload.document_kind, "arm_initial_disclosure_consummation"); assert.equal(ver.events[1]!.payload.days_consummation_to_first_new_payment, 205); assert.equal(o.status(TIMERS.deadline), "satisfied");
});
test("7.3-T7: Given the notice is co-mailed with the periodic statement, then it is a separate PDF with its own first page and the composer log shows two documents in one envelope.", async () => {
  const reg = buildRegistry();
  const env = planEnvelopes([{ noticeId: "n1", template: reg.template("NTC_REGZ_41_STMT_STD"), partyId: "A" }, { noticeId: "n2", template: reg.template("NTC_REGZ_20D_ARM_INITIAL"), partyId: "A" }]);
  assert.equal(env.length, 1); assert.deepEqual(env[0]!.items.map((i) => i.noticeId), ["n1", "n2"]); assert.deepEqual(env[0]!.separatePdfs, ["n2"]);
  const e = composeEnvelope([{ template: "NTC_REGZ_41_STMT_STD", separate_document: reg.template("NTC_REGZ_41_STMT_STD").separateDocument, pages: 2 }, { template: "NTC_REGZ_20D_ARM_INITIAL", separate_document: reg.template("NTC_REGZ_20D_ARM_INITIAL").separateDocument, pages: 1 }]);
  assert.equal(e.envelope_count, 1); assert.equal(e.documents.length, 2); assert.equal(e.pdf_count, 2);
  assert.deepEqual(e.documents[0], { template: "NTC_REGZ_41_STMT_STD", own_pdf: false, pdf_index: 1, first_page: 1 });
  assert.deepEqual(e.documents[1], { template: "NTC_REGZ_20D_ARM_INITIAL", own_pdf: true, pdf_index: 2, first_page: 3 });
  assert.equal(e.composer_log, "2 documents in one envelope: NTC_REGZ_41_STMT_STD + NTC_REGZ_20D_ARM_INITIAL (2 PDFs; separate: NTC_REGZ_20D_ARM_INITIAL)");
  const merged = composeEnvelope([{ template: "NTC_REGZ_41_STMT_STD", separate_document: false, pages: 2 }, { template: "NTC_REGZ_41_STMT_AVAIL_EMAIL", separate_document: false, pages: 1 }]);
  assert.equal(merged.pdf_count, 1); assert.equal(merged.documents[1]!.own_pdf, false);                                   // non-separate documents share one PDF
  // through the process: the send's `notice.render_requested{template, separate_document=true}` arms SM_ARM_INITIAL_SEPARATE_DOC_GATE, its evaluator opens, the print job is its own document
  const r = rig("2026-01-15"); r.board("2026-01-15"); O.determineInitialNoticeStatus(r.deps(), { loan_id: LOAN, transferor_evidence: null });
  r.at("2026-04-20"); A.captureIndex(r.deps(), nyfed("2026-04-20", "3.64381")); O.requestInitialNoticeRender(r.deps(), { loan_id: LOAN });
  r.at("2026-04-21"); const s = await O.sendInitialNotice(r.deps(), r.notices, { loan_id: LOAN, ...SEND });
  assert.equal(s.separate_document, true); assert.equal(s.render_requested_event.type, "notice.render_requested"); assert.equal(s.render_requested_event.payload.template, "NTC_REGZ_20D_ARM_INITIAL"); assert.equal(s.render_requested_event.payload.separate_document, true);
  const gate = r.engine.byCode("SM_ARM_INITIAL_SEPARATE_DOC_GATE")[0]!; assert.equal(gate.status, "armed"); assert.equal(gate.note, "evaluator:7.3.separateDocumentEnforced"); assert.equal(gate.armedByEventId, s.render_requested_event.id);
  assert.equal(evaluateGate("7.3.separateDocumentEnforced", s.render_requested_event.payload).open, true); assert.equal(evaluateGate("7.3.separateDocumentEnforced", { ...s.render_requested_event.payload, separate_document: false }).open, false);
  const job = [...r.pm.jobs.values()][0]!.job; assert.equal(job.template, "NTC_REGZ_20D_ARM_INITIAL"); assert.equal(job.separateDocument, true); assert.equal(job.pages, 1);
  // a composer that lost the flag is blocked before rendering
  const bad = rig("2026-01-15"); bad.board("2026-01-15"); O.determineInitialNoticeStatus(bad.deps(), { loan_id: LOAN, transferor_evidence: null });
  bad.at("2026-04-20"); A.captureIndex(bad.deps(), nyfed("2026-04-20", "3.64381")); O.requestInitialNoticeRender(bad.deps(), { loan_id: LOAN });
  const noFlag: O.NoticeSender7_3 = { render: (i) => bad.notices.render(i), send: (id, ctx) => bad.notices.send(id, ctx), template: () => ({ separateDocument: false }) };
  await assert.rejects(O.sendInitialNotice(bad.deps(), noFlag, { loan_id: LOAN, ...SEND }), /SM_ARM_INITIAL_SEPARATE_DOC_GATE: §1026\.20\(d\) notice must be its own document/);
  assert.deepEqual(bad.sentTemplates(LOAN), []);
});
test("7.3-T8: Given a Texas property, then the (xi) block names the Texas state housing finance authority from `jurisdiction_rules`.", async () => {
  const rules = { TX: { hfa_name: "Texas Department of Housing and Community Affairs", hfa_phone: "(800) 792-1119" }, CA: { hfa_name: "California Housing Finance Agency", hfa_phone: "(877) 922-5432" } };
  assert.deepEqual(stateHfaContact("TX", rules), rules.TX); assert.throws(() => stateHfaContact("ZZ", rules), /no state HFA contact/);
  // through the process: the (xi) block of the rendered notice carries the CFPB URL, the HUD number and the Texas HFA from jurisdiction_rules by property state
  const r = rig("2026-01-15"); r.board("2026-01-15"); O.determineInitialNoticeStatus(r.deps(), { loan_id: LOAN, transferor_evidence: null });
  r.at("2026-04-20"); A.captureIndex(r.deps(), nyfed("2026-04-20", "3.64381")); O.requestInitialNoticeRender(r.deps(), { loan_id: LOAN });
  r.at("2026-04-21"); const s = await O.sendInitialNotice(r.deps(), r.notices, { loan_id: LOAN, ...SEND, property_state: "TX", hfa_rules: rules });
  const text = r.notices.get(s.notice_id).rendered.text;
  assert.match(text, /CFPB: consumerfinance\.gov · HUD \(800\) 569-4287 · Texas Department of Housing and Community Affairs \(800\) 792-1119/);
  assert.equal(s.payload.state_hfa_contact, "Texas Department of Housing and Community Affairs (800) 792-1119"); assert.equal(s.payload.property_state, "TX");
  assert.equal(r.notices.get(s.notice_id).checklist.results.find((x) => x.rule_id === "xi-state-hfa")!.passed, true);
  // a state without an HFA row in jurisdiction_rules refuses to render (no numbers or names from anywhere but the table)
  const zz = rig("2026-01-15"); zz.board("2026-01-15"); O.determineInitialNoticeStatus(zz.deps(), { loan_id: LOAN, transferor_evidence: null });
  zz.at("2026-04-20"); A.captureIndex(zz.deps(), nyfed("2026-04-20", "3.64381")); O.requestInitialNoticeRender(zz.deps(), { loan_id: LOAN });
  await assert.rejects(O.sendInitialNotice(zz.deps(), zz.notices, { loan_id: LOAN, ...SEND, property_state: "ZZ", hfa_rules: rules }), /no state HFA contact for ZZ in jurisdiction_rules/);
  assert.deepEqual(zz.sentTemplates(LOAN), []);
});
test("7.3-T9: Given the margin is corrected on 2026-04-28 after a 2026-04-21 send, then a corrected (d) notice is sent by 2026-05-05.", async () => {
  const p = correctedInitialNotice({ sent_on: D("2026-04-21"), corrected_on: D("2026-04-28"), first_new_payment_due: D("2026-12-01") });
  assert.equal(p.action, "send_corrected_d_notice"); assert.equal(p.send_by, "2026-05-05"); assert.equal(p.days_out, 217);
  assert.equal(correctedInitialNotice({ sent_on: D("2026-04-21"), corrected_on: D("2026-06-01"), first_new_payment_due: D("2026-12-01") }).action, "rely_on_c_notice");
  // through the process: the April 21 send, then `loan.terms.corrected` (margin 2.750 → 2.875) on April 28 → a corrected (d) notice re-estimated on the corrected margin: 3.64381 + 2.875 = 6.51881 → 6.500%, $2,505.35 on $371,048.86 over 300 months
  const r = rig("2026-01-15"); r.board("2026-01-15"); O.determineInitialNoticeStatus(r.deps(), { loan_id: LOAN, transferor_evidence: null });
  r.at("2026-04-20"); A.captureIndex(r.deps(), nyfed("2026-04-20", "3.64381")); O.requestInitialNoticeRender(r.deps(), { loan_id: LOAN });
  r.at("2026-04-21"); const first = await O.sendInitialNotice(r.deps(), r.notices, { loan_id: LOAN, ...SEND });
  assert.equal(first.payload.margin_pct, "2.750"); assert.equal(r.status(TIMERS.deadline), "satisfied");
  await assert.rejects(O.sendInitialNotice(r.deps(), r.notices, { loan_id: LOAN, ...SEND }), /already sent .* goes through correctInitialNoticeTerms/);
  r.at("2026-04-28"); A.captureIndex(r.deps(), nyfed("2026-04-28", "3.64381"));
  const c = await O.correctInitialNoticeTerms(r.deps(), r.notices, { loan_id: LOAN, corrected_on: D("2026-04-28"), changes: { margin_pct: "2.875" }, ...SEND });
  assert.equal(c.action, "send_corrected_d_notice"); assert.equal(c.send_by, "2026-05-05"); assert.equal(c.days_out, 217); assert.equal(c.terms_version, 2);
  assert.equal(c.corrected_event.type, "loan.terms.corrected"); assert.deepEqual(c.corrected_event.payload.fields, [{ field: "margin_pct", from: "2.750", to: "2.875" }]);
  assert.equal(c.notice!.sent_on, "2026-04-28"); assert.ok(daysBetween(c.notice!.sent_on, c.send_by!) >= 0); assert.equal(c.notice!.late, false); assert.equal(c.notice!.days_before_first_payment, 217);
  assert.equal(c.notice!.payload.margin_pct, "2.875"); assert.equal(c.notice!.payload.estimated_rate_pct, "6.500"); assert.equal(c.notice!.payload.estimated_payment_cents, 250535n); assert.equal(c.notice!.payload.floor_pct, "2.875"); assert.equal(c.notice!.payload.corrected, true);
  const text = r.notices.get(c.notice!.notice_id).rendered.text;
  assert.match(text, /Estimated new rate 6\.500% \(estimated\) .* plus a margin of 2\.875%; estimated new payment \$2,505\.35 \(estimated\)/);
  assert.match(text, /This notice corrects and replaces the notice dated April 21, 2026; the corrected term is margin 2\.750% → 2\.875%/);
  assert.deepEqual(r.sentTemplates(LOAN), ["NTC_REGZ_20D_ARM_INITIAL", "NTC_REGZ_20D_ARM_INITIAL"]);
  assert.equal(c.notice!.event.payload.corrected, true); assert.equal(c.notice!.event.payload.supersedes_notice_id, first.notice_id); assert.equal(c.notice!.event.payload.satisfies_timer, true);
  assert.equal(A.loadTerms(r.deps(), LOAN).margin_pct, "2.875"); assert.equal(A.loadTerms(r.deps(), LOAN).version, 2); assert.equal(r.store.list("arm_initial_estimates").length, 2);
  // corrected after T−210 (June 1): no corrected (d) notice — the (c) notice carries the correct figures and the discrepancy is documented
  const late = rig("2026-01-15"); late.board("2026-01-15"); O.determineInitialNoticeStatus(late.deps(), { loan_id: LOAN, transferor_evidence: null });
  late.at("2026-04-20"); A.captureIndex(late.deps(), nyfed("2026-04-20", "3.64381")); O.requestInitialNoticeRender(late.deps(), { loan_id: LOAN });
  late.at("2026-04-21"); await O.sendInitialNotice(late.deps(), late.notices, { loan_id: LOAN, ...SEND });
  late.at("2026-06-01"); const rely = await O.correctInitialNoticeTerms(late.deps(), late.notices, { loan_id: LOAN, corrected_on: D("2026-06-01"), changes: { margin_pct: "2.875" }, ...SEND });
  assert.equal(rely.action, "rely_on_c_notice"); assert.equal(rely.notice, null); assert.equal(rely.discrepancy_event!.type, "arm.initial_notice.discrepancy_documented"); assert.equal(late.sentTemplates(LOAN).length, 1);
});

test("7.3 worked example: expected UPB $371,048.86 and current P&I $2,334.29 feed the (d) estimate ($2,476.44 estimated at 6.375%)", () => {
  assert.equal(scheduledUpbAfter(40000000n, "5.750", 233429n, 60), 37104886n); assert.equal(newPayment(37104886n, "6.375", 300), 247644n);
});
test("7.3 timers: the registry rows arm on the events ops-7-3 / ops-7-2 append and close on the ones the spec names", () => {
  const reg = loadOverriddenRegistry();
  const fc = reg.get("SM_ARM_INITIAL_FILE_CHECK_T0")!; assert.equal(fc.triggerPattern!.type, "arm.initial_notice.file_check_opened"); assert.deepEqual(fc.triggerPattern!.conditions, [{ field: "within_300_days", op: "=", value: "true" }]); assert.equal(fc.anchorField, "boarded_on"); assert.equal(fc.satisfiedPattern!.type, "arm.initial_notice.status_determined");
  const dl = reg.get("REGZ_1026_20D_INITIAL_NOTICE_210")!; assert.equal(dl.satisfiedPattern!.type, "arm.initial_notice.*"); assert.deepEqual(dl.satisfiedPattern!.conditions, [{ field: "satisfies_timer", op: "=", value: "true" }]);
  const ev = (type: string, payload: Record<string, unknown>) => ({ id: "e", type, occurredAt: "2026-06-02T18:00:00.000Z", loanId: LOAN, actor: SYSTEM, payload, sequence: 1 });
  for (const t of ["arm.initial_notice.sent", "arm.initial_notice.transferor_evidenced", "arm.initial_notice.originator_duty", "arm.initial_notice.exempt_short_term"]) assert.equal(eventMatches(dl.satisfiedPattern!, ev(t, { satisfies_timer: true })), true, t);
  for (const t of ["arm.initial_notice.window_opened", "arm.initial_notice.file_check_opened", "arm.initial_notice.render_requested", "arm.initial_notice.status_determined", "arm.initial_notice.late", "arm.initial_notice.originator_duty"]) assert.equal(eventMatches(dl.satisfiedPattern!, ev(t, { status: "late" })), false, t);
  assert.equal(eventMatches(fc.triggerPattern!, ev("arm.initial_notice.file_check_opened", { within_300_days: false })), false);
  const gate = reg.get("REGZ_1026_20D_ESTIMATE_INDEX_15BD")!; assert.equal(gate.triggerPattern!.type, "arm.initial_notice.render_requested"); assert.deepEqual(gate.offsetParsed, { kind: "evaluator", ref: "7.3.indexRecentEnoughForEstimate" });
  const sep = reg.get("SM_ARM_INITIAL_SEPARATE_DOC_GATE")!; assert.equal(sep.triggerPattern!.type, "notice.render_requested"); assert.deepEqual(sep.offsetParsed, { kind: "evaluator", ref: "7.3.separateDocumentEnforced" });
  // a boarded loan whose first new payment is beyond 300 days opens no file-check clock (the window will open on its own schedule)
  const r = rig("2025-06-01"); const { fc: far } = r.board("2025-06-01");
  assert.equal(far.within_300_days, false); assert.equal(far.timer, null); assert.equal(far.days_to_first_new_payment, 548); assert.equal(r.engine.byCode("SM_ARM_INITIAL_FILE_CHECK_T0").length, 0);
  // cancellation (payoff before the first change) with a reason
  const c = O.cancelInitialNotice(r.deps(), { loan_id: LOAN, reason: "paid_off" }); assert.equal(c.event.payload.reason, "paid_off"); assert.equal(O.loadState(r.deps(), LOAN).status, "cancelled");
  assert.throws(() => O.determineInitialNoticeStatus(r.deps(), { loan_id: LOAN, transferor_evidence: null }), /cancelled \(paid_off\)/);
});
