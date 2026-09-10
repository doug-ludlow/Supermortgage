// 9.4 Force-placed renewal notice
// spec/sections/09-insurance-property-protection/9-4-force-placed-renewal-notice.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
//
// Every T-id runs through the 9.4 renewal service (ops-9-4.ts) with the TimerEngine armed from the process's own events
// (registry + section + 9.4 overrides), so the §1024.37(e) clocks are proven as armed/satisfied timer instances, not as
// date arithmetic alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, addDays } from "../../kernel/calendar/date.ts";
import { MemoryEventStore, FixedClock, eventMatches, type DomainEvent } from "../../kernel/events/index.ts";
import { TimerEngine } from "../../kernel/timers/engine.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { Fpi94Service, fpiReactors_9_4, MS3D, FPI_94_TIMERS, type ScheduleRenewalInput } from "./ops-9-4.ts";
import { Fpi92Service, fpiReactors_9_2, type JurisdictionRule } from "./ops-9-2.ts";
import { renewalClocks, renewalChargeAllowed, renewalCharge, renewalNoticeAllowed, gapChargeDecision, lpiCoverage, tierDeductible, premiumQuote, premiumFromRate, boldItemsPresent, noticeChecklist } from "./fpi.ts";
import { dailyRate } from "./refund.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { NoticeService } from "../../notices/service.ts";
import { FakePrintMail, FakeEdelivery } from "../../infra/integrations/delivery.ts";
import type { TemplateVersion, VersionInput } from "../../notices/registry.ts";
import { SECTION_09_VERSIONS } from "../../notices/authored/section09.ts";

const ANNUAL = "REGX_1024_37E5_FPI_RENEWAL_NOTICE_ANNUAL", GATE45 = "REGX_1024_37E_FPI_RENEWAL_NOTICE_45", GAP = "REGX_1024_37E1III_GAP_PROMPT_CHARGE", REVIEW60 = "INS_FPI_RENEWAL_COVERAGE_REVIEW_60";
const REG = loadOverriddenRegistry();
const JURIS: Record<string, JurisdictionRule> = { TX: { state: "TX", lpi_prompt_charge_prohibited: false }, NP: { state: "NP", lpi_prompt_charge_prohibited: true }, CA: { state: "CA", hazard_amount_cap_rule: "rcv", lpi_prompt_charge_prohibited: false } };
const MS3D_V = SECTION_09_VERSIONS.find((v) => v.templateCode === MS3D)!;
const asVersion = (v: VersionInput): TemplateVersion => ({ ...v, sourceHash: "test", plainLanguageStatus: "draft" } as unknown as TemplateVersion);
const FACTS = { borrower_name: "Bea Borrower", borrower_address: "1 Test St, Testville TX 75001", property_address: "1 Test St, Testville TX 75001", account_last4: "1234", servicer_phone: "(800) 555-0100", servicer_address: "PO Box 1, Testville TX 75001", insurance_email: "insurance@example.com" };
/** The 9.2 worked placement: LPI 2026-10-01 → 2027-10-01, $250,000 / $2,000 deductible, $2,190.00, charged 2026-11-19 (9.2-T2). */
const PLACED: ScheduleRenewalInput = { case_id: "fpi-L-94", loan_id: "L-94", placement_id: "lpi-1", placement_effective: D("2026-10-01"), placement_expiration: D("2027-10-01"), premium_cents: 219_000n, coverage_cents: 25_000_000n, deductible_cents: 200_000n, state: "TX", escrowed: false, scheduled_on: D("2026-11-19") };
const COVER = { last_known_cents: 25_000_000n, rcv_cents: 26_200_000n, upb_cents: 20_000_000n };
const mailed = (case_id: string, notice_id: string, mailed_at: ReturnType<typeof D>, produced_at = mailed_at) => ({ case_id, notice_id, mailed_at, produced_at, mail_class: "first_class", proof_of_mailing_id: `POM-${notice_id}` });

function harness(nowIso = "2026-11-19T14:00:00.000Z", processes: string[] = ["9.4"]) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock); const ledger = new MemoryLedger();
  const timers = new TimerEngine(REG, events, { processes });
  const svc = new Fpi94Service({ events, clock, timers, ledger, jurisdiction: (s) => JURIS[s] });
  const off = fpiReactors_9_4(svc, events);
  const inst = (code: string, n = -1) => timers.byCode(code).at(n);
  const types = (loanId: string) => events.byLoan(loanId).map((e) => e.type).filter((t) => !t.startsWith("timer."));
  const at = (iso: string) => { clock.set(iso); return D(iso.slice(0, 10)); };
  return { clock, events, ledger, timers, svc, off, inst, types, at };
}
/** Scheduled at the 9.2 charge; the A − 60 window (2027-08-02) opened, coverage reviewed and the $2,250.00 renewal quoted (rule 5). */
function windowOpen(h: ReturnType<typeof harness>, over: Partial<ScheduleRenewalInput> = {}) {
  const r = h.svc.scheduleRenewal({ ...PLACED, ...over });
  h.at("2027-08-02T14:00:00.000Z");
  assert.equal(h.svc.sweep(D("2027-08-02")).length, 1);
  h.svc.reviewCoverage(r.id, COVER, D("2027-08-02"));
  h.svc.recordRenewalQuote(r.id, { carrier_quote_cents: 225_000n, table_rate_pct: "0.9" }, D("2027-08-02"));
  return r;
}

test("9.4-T1: Given placement effective 2026-10-01 When 2027-08-02 Then MS-3(D) mailed; renewal charge refused before 2027-09-16.", () => {
  const c = renewalClocks(D("2026-10-01"), D("2027-08-02"));
  assert.equal(c.anniversary, "2027-10-01"); assert.equal(c.notice_target, "2027-08-02"); assert.equal(c.chargeable, "2027-09-16");
  assert.equal(renewalChargeAllowed(c, D("2027-09-15")).allowed, false); assert.match(renewalChargeAllowed(c, D("2027-09-15")).reason!, /REGX_1024_37E_FPI_RENEWAL_NOTICE_45/);
  assert.equal(renewalChargeAllowed(c, D("2027-10-01")).allowed, true);                                // charge_on = max(A, t2 + 45) = A
  assert.deepEqual(renewalChargeAllowed(renewalClocks(D("2026-10-01"), null), D("2027-10-01")), { allowed: false, reason: "RENEWAL_NOTICE_NOT_MAILED" });
  // The cycle scheduled at the 9.2 charge (2026-11-19): A = 2027-10-01, notice target A − 60 = 2027-08-02; the recurring annual row arms on A, due A − 45 = 2027-08-17.
  const h = harness();
  const r = h.svc.scheduleRenewal(PLACED);
  assert.equal(r.anniversary_date, "2027-10-01"); assert.equal(r.notice_target, "2027-08-02"); assert.equal(r.review_on, "2027-08-02"); assert.equal(r.status, "scheduled"); assert.equal(r.renewal_cycle, 1);
  const annual = h.inst(ANNUAL)!; assert.equal(annual.anchorDate, "2027-10-01"); assert.equal(annual.dueDate, "2027-08-17"); assert.equal(annual.status, "armed"); assert.equal(annual.loanId, "L-94");
  assert.ok(eventMatches(REG.get(ANNUAL)!.triggerPattern!, h.events.ofType("fpi.renewal.scheduled")[0]!));
  // 2027-08-02 = A − 60: the window opens (fpi.anniversary.approaching{days_before=60} arms the B-2-01 review, due the same day), the review closes it, the carrier quote lands.
  h.at("2027-08-02T14:00:00.000Z");
  const approaching = h.svc.openRenewalWindow(r.id, D("2027-08-02")); assert.equal(approaching.payload.days_before, 60); assert.equal(approaching.payload.anniversary_on, "2027-10-01");
  assert.ok(eventMatches(REG.get(REVIEW60)!.triggerPattern!, approaching));
  const review = h.inst(REVIEW60)!; assert.equal(review.anchorDate, "2027-10-01"); assert.equal(review.dueDate, "2027-08-02"); assert.equal(review.status, "armed");
  const rev = h.svc.reviewCoverage(r.id, COVER, D("2027-08-02")); assert.equal(rev.coverage_cents, 25_000_000n); assert.equal(rev.adjustment, "none");
  assert.equal(review.status, "satisfied"); assert.equal(review.satisfiedByEventId, rev.event.id);
  assert.throws(() => h.svc.composeRenewalNotice(r.id, { ...FACTS, notice_date: D("2027-08-02") }), /without the renewal quote/);   // (e)(2)(vii)(C): cost as an annual premium
  const q = h.svc.recordRenewalQuote(r.id, { carrier_quote_cents: 225_000n, table_rate_pct: "0.9" }, D("2027-08-02")); assert.equal(q.annual_premium_cents, 225_000n); assert.equal(q.is_estimate, false);
  // The MS-3(D) composed from the case: (e)(2)(i)–(xi) checklist, (e)(3) bold items, (e)(4) nothing else — then mailed first-class on 2027-08-02 (t2).
  const composed = h.svc.composeRenewalNotice(r.id, { ...FACTS, notice_date: D("2027-08-02") });
  assert.equal(composed.template, MS3D); assert.equal(composed.payload.annual_premium_cents, 225_000n); assert.equal(composed.payload.days_before_anniversary, 60); assert.equal(composed.payload.expired, false);
  const payload = { ...MS3D_V.samplePayload, ...composed.payload };
  const rendered = render(MS3D_V.source, payload);                                                     // the MS-3(D) that is mailed on 2027-08-02
  assert.equal(evaluateChecklist(asVersion(MS3D_V), payload, rendered).passed, true);
  assert.deepEqual(boldItemsPresent(rendered.blocks, [/immediately provide us with updated hazard insurance information/i, /because hazard insurance is required on your property, we intend to maintain insurance on your property by renewing or replacing/i, /may cost significantly more .* may not provide as much coverage/i, /will cost \$2,250\.00 annually/]), { ok: true, missing: [] });   // (e)(3): (iv), (vi)(B), (vii)(A)–(C)
  assert.match(rendered.text, /we previously purchased insurance on your property at your expense, effective October 1, 2026/); assert.match(rendered.text, /The insurance we bought is expiring on October 1, 2027/);
  assert.equal(noticeChecklist(rendered.blocks.map((b) => ({ id: b.id, text: b.text })), "renewal").ok, true);   // (e)(4)
  const clocks = h.svc.recordRenewalNoticeMailed(mailed(PLACED.case_id, "n-ms3d", D("2027-08-02")));
  assert.equal(clocks.chargeable, "2027-09-16"); assert.equal(clocks.charge_on, "2027-10-01"); assert.equal(h.svc.get(r.id).status, "notice_sent"); assert.equal(h.svc.get(r.id).earliest_renewal_charge_date, "2027-09-16");
  const sent = h.events.ofType("fpi.renewal_notice.sent")[0]!; assert.equal(sent.payload.renewal_notice_mailed_at, "2027-08-02"); assert.equal(sent.payload.template, MS3D); assert.equal(sent.payload.slipped, false);
  assert.ok(eventMatches(REG.get(ANNUAL)!.satisfiedPattern!, sent)); assert.ok(eventMatches(REG.get(GATE45)!.triggerPattern!, sent));
  assert.equal(annual.status, "satisfied"); assert.equal(annual.satisfiedByEventId, sent.id);
  const rearmed = h.inst(ANNUAL)!; assert.notEqual(rearmed.id, annual.id); assert.equal(rearmed.anchorDate, "2028-10-01"); assert.equal(rearmed.dueDate, "2028-08-17");   // (e)(5): before each anniversary
  const gate = h.inst(GATE45)!; assert.equal(gate.anchorDate, "2027-08-02"); assert.equal(gate.dueDate, "2027-09-16"); assert.equal(gate.status, "armed");
  // Before 2027-09-16 the gate is closed: nothing overdue, the charge command refused, no charge event; and before A even with the gate open (coverage renews on A).
  h.at("2027-09-15T14:00:00.000Z");
  assert.deepEqual(h.timers.evaluate("2027-09-15T14:00:00.000Z"), []);
  assert.throws(() => h.svc.assessRenewalCharge(r.id, D("2027-09-15")), /REGX_1024_37E_FPI_RENEWAL_NOTICE_45 open until 2027-10-01/);
  assert.equal(h.svc.chargeAllowed(r.id, D("2027-09-30")).allowed, false); assert.equal(gate.status, "armed"); assert.equal(h.events.ofType("fpi.renewal.charged").length, 0);
  // On A the gate is open but the charge waits for the bound renewal term; bound → charged $2,250.00, the gate closes on the charge and the next term is scheduled without a second annual instance.
  h.at("2027-10-01T14:00:00.000Z");
  assert.throws(() => h.svc.assessRenewalCharge(r.id, D("2027-10-01")), /bound renewal term/);
  const p = h.svc.recordRenewalBound({ renewal_id: r.id, policy_number: "LPI-TX-0002", premium_cents: 225_000n, effective: D("2027-10-01") });
  assert.equal(p.previous_placement_id, "lpi-1"); assert.equal(p.expiration_date, "2028-10-01"); assert.equal(p.coverage_amount_cents, 25_000_000n);
  const res = h.svc.assessRenewalCharge(r.id, D("2027-10-01"));
  assert.equal(res.amount_cents, 225_000n); assert.equal(res.event.payload.charged_on, "2027-10-01"); assert.equal(res.event.payload.period_start, "2027-10-01"); assert.equal(res.event.payload.period_end, "2028-09-30");
  assert.deepEqual(res.ledger!.lines.map((l) => [l.account.account, l.amountCents]), [["corporate_advance", 225_000n], ["corporate_cash", -225_000n]]);   // 9.2 rule 7
  assert.ok(eventMatches(REG.get(GATE45)!.satisfiedPattern!, res.event)); assert.equal(gate.status, "satisfied"); assert.equal(gate.satisfiedByEventId, res.event.id);
  assert.equal(h.svc.get(r.id).status, "charged"); assert.equal(res.next.renewal_cycle, 2); assert.equal(res.next.origin, "prior_renewal"); assert.equal(res.next.anniversary_date, "2028-10-01");
  assert.equal(h.timers.byCode(ANNUAL).length, 2); assert.equal(h.timers.byCode(GATE45).length, 1);
  assert.deepEqual(h.types("L-94"), ["fpi.renewal.scheduled", "fpi.anniversary.approaching", "fpi.renewal.coverage_reviewed", "fpi.renewal.quoted", "fpi.renewal_notice.sent", "fpi.renewal.bound", "fpi.renewal.chargeable", "fpi.renewal.charged", "fpi.renewal.scheduled"]);
});
test("9.4-T2: Given the notice mailed 2027-09-10 Then renewal coverage binds 2027-10-01 but the charge posts 2027-10-25.", () => {
  const c = renewalClocks(D("2026-10-01"), D("2027-09-10"));
  assert.equal(c.anniversary, "2027-10-01"); assert.equal(c.chargeable, "2027-10-25"); assert.equal(c.charge_on, "2027-10-25");   // servicer carries 24 days
  assert.equal(renewalChargeAllowed(c, D("2027-10-24")).allowed, false); assert.equal(renewalChargeAllowed(c, D("2027-10-25")).allowed, true);
  const h = harness(); const r = windowOpen(h);
  // A − 45 = 2027-08-17 passes without the MS-3(D): the annual row breaches sev-1 (the charge date slips; coverage itself continues).
  const annual = h.inst(ANNUAL)!; assert.equal(annual.dueDate, "2027-08-17");
  const breaches = h.timers.evaluate("2027-08-18T14:00:00.000Z"); assert.deepEqual(breaches.map((b) => [b.instance.code, b.severity]), [[ANNUAL, 1]]);
  h.at("2027-09-10T14:00:00.000Z");
  const clocks = h.svc.recordRenewalNoticeMailed(mailed(PLACED.case_id, "n-ms3d-late", D("2027-09-10")));
  assert.equal(clocks.chargeable, "2027-10-25"); assert.equal(clocks.charge_on, "2027-10-25"); assert.equal(annual.status, "satisfied_late");
  const sent = h.events.ofType("fpi.renewal_notice.sent")[0]!; assert.equal(sent.payload.slipped, true); assert.equal(sent.payload.servicer_carries_days, 24); assert.equal(sent.payload.days_before_anniversary, 21);
  const gate = h.inst(GATE45)!; assert.equal(gate.anchorDate, "2027-09-10"); assert.equal(gate.dueDate, "2027-10-25");
  // Coverage renews on A = 2027-10-01 regardless (lpi_renewal_bound), but the charge is refused until t2 + 45.
  h.at("2027-10-01T14:00:00.000Z");
  const p = h.svc.recordRenewalBound({ renewal_id: r.id, policy_number: "LPI-TX-0002", premium_cents: 225_000n, effective: D("2027-10-01") });
  assert.equal(p.effective_date, "2027-10-01"); assert.equal(h.events.ofType("fpi.renewal.bound")[0]!.payload.chargeable, false);
  assert.throws(() => h.svc.assessRenewalCharge(r.id, D("2027-10-01")), /REGX_1024_37E_FPI_RENEWAL_NOTICE_45 open until 2027-10-25/);
  assert.throws(() => h.svc.recordRenewalBound({ renewal_id: r.id, policy_number: "LPI-TX-0003", premium_cents: 225_000n, effective: D("2027-10-25") }), /already bound/);
  h.at("2027-10-24T14:00:00.000Z"); assert.throws(() => h.svc.assessRenewalCharge(r.id, D("2027-10-24")), /open until 2027-10-25/); assert.equal(gate.status, "armed");
  h.at("2027-10-25T14:00:00.000Z"); assert.deepEqual(h.timers.evaluate("2027-10-25T14:00:00.000Z"), []);
  const res = h.svc.assessRenewalCharge(r.id, D("2027-10-25"));
  assert.equal(res.event.payload.charged_on, "2027-10-25"); assert.equal(res.event.payload.period_start, "2027-10-01"); assert.equal(res.amount_cents, 225_000n); assert.equal(gate.status, "satisfied");
  assert.equal(h.svc.get(r.id).charged_on, "2027-10-25"); assert.equal(h.svc.get(r.id).status, "charged");
});
test("9.4-T3: Given a second MS-3(D) attempted 200 days after the first for the same anniversary Then refused ((e)(5)).", () => {
  const last = { mailed: D("2027-08-02"), anniversary: D("2027-10-01") };
  assert.equal(renewalNoticeAllowed(last, D("2027-10-01"), D("2028-02-18")), false);                    // 200 days later, same anniversary
  assert.equal(renewalNoticeAllowed(last, D("2028-10-01"), D("2028-08-02")), true);                     // next anniversary, ≥ 365 days
  assert.equal(renewalNoticeAllowed(null, D("2027-10-01"), D("2027-08-02")), true);
  const h = harness(); const r = windowOpen(h);
  h.svc.recordRenewalNoticeMailed(mailed(PLACED.case_id, "n-ms3d", D("2027-08-02")));
  assert.equal(h.svc.get(r.id).notice_mailed_at, "2027-08-02");
  // 2028-02-18 = 200 days later, same anniversary: refused by the guardrail, the compose step and the proof-of-mailing ingestion alike.
  const on = h.at("2028-02-18T14:00:00.000Z"); assert.equal(addDays(D("2027-08-02"), 200), on);
  const a = h.svc.noticeAllowed(r.id, on); assert.equal(a.allowed, false); assert.match(a.reason!, /REGX_1024_37E5_FPI_RENEWAL_NOTICE_ANNUAL.*\(e\)\(5\)/);
  assert.throws(() => h.svc.composeRenewalNotice(r.id, { ...FACTS, notice_date: on }), /\(e\)\(5\)/);
  assert.throws(() => h.svc.recordRenewalNoticeMailed(mailed(PLACED.case_id, "n-ms3d-2", on)), /one notice per year \(§1024\.37\(e\)\(5\)\)/);
  h.events.append({ type: "notice.mailed", loanId: "L-94", aggregate: { kind: "notice", id: "n-ms3d-2" }, actor: { kind: "agent", id: "disclosures" }, payload: { notice_id: "n-ms3d-2", template: MS3D, attempt_no: 1, mailed_at: "2028-02-18T14:00:00.000Z", proof_of_mailing_id: "POM-2" } });
  const rejected = h.events.ofType("fpi.inbound.rejected"); assert.equal(rejected.length, 1); assert.equal(rejected[0]!.payload.inbound, "renewal_notice_proof_of_mailing"); assert.match(String(rejected[0]!.payload.reason), /\(e\)\(5\)/);
  assert.equal(h.events.ofType("fpi.renewal_notice.sent").length, 1); assert.equal(h.timers.byCode(GATE45).length, 1); assert.equal(h.svc.get(r.id).notice_mailed_at, "2027-08-02");
  // The checklist's (e)(5) rule refuses the same second notice at render time (days_since_last_renewal_notice = 200 < 365).
  const payload = { ...MS3D_V.samplePayload, notice_date: "2028-02-18", days_since_last_renewal_notice: 200 };
  const chk = evaluateChecklist(asVersion(MS3D_V), payload, render(MS3D_V.source, payload)); assert.equal(chk.passed, false); assert.ok(chk.blocking.some((b) => b.rule_id === "annual"));
});
test("9.4-T4: Given evidence of a 20-day post-expiration gap in a state without a prohibition Then prompt gap charge for 20 days at the renewal daily rate; in a prohibited state a new 9.2 cycle opens.", () => {
  const rc = renewalCharge(D("2026-10-01"), D("2027-08-02"), premiumQuote(225000n, 25000000n, "0.9"));
  assert.equal(rc.daily_rate.toFixed(6), "614.754098");                                               // $2,250.00 ÷ 366 days (2027-10-01 → 2028-10-01)
  const g = gapChargeDecision(20, rc.daily_rate, false);
  assert.deepEqual(g, { action: "prompt_charge", cents: 12295n });                                      // 20 × 614.754098 = 12,295.08 → $122.95
  assert.deepEqual(gapChargeDecision(20, rc.daily_rate, true), { action: "new_cycle" });
  /** The renewal term charged on A: $2,250.00 for 2027-10-01 → 2028-10-01; the borrower's own policy then ends the LPI (9.5) and lapses again after the LPI expired. */
  const charged = (h: ReturnType<typeof harness>, over: Partial<ScheduleRenewalInput> = {}) => {
    const r = windowOpen(h, over); h.svc.recordRenewalNoticeMailed(mailed(r.fpi_case_id, "n-ms3d", D("2027-08-02")));
    h.at("2027-10-01T14:00:00.000Z"); h.svc.recordRenewalBound({ renewal_id: r.id, policy_number: "LPI-0002", premium_cents: 225_000n, effective: D("2027-10-01") });
    const res = h.svc.assessRenewalCharge(r.id, D("2027-10-01")); assert.equal(res.daily_rate.toFixed(6), "614.754098");
    h.svc.closeRenewal(res.next.id, "closed_evidence", "borrower policy evidenced 2028-03-01 (9.5)");
    assert.ok(h.timers.open().every((t) => !FPI_94_TIMERS.includes(t.code)));                          // the renewal cycle is cancelled with its clocks
    return r;
  };
  // TX (lpi_prompt_charge_prohibited=false): the 20-day gap 2028-10-01 → 2028-10-21 after the LPI expired → the flag row arms on fpi.gap.evidenced and the prompt charge is $122.95.
  const h = harness(); charged(h);
  const on = h.at("2028-11-02T14:00:00.000Z");
  const ev = h.svc.recordGapEvidence({ case_id: PLACED.case_id, gap_start: D("2028-10-01"), gap_end: D("2028-10-21"), evidence_id: "doc-gap-1", received_on: on });
  assert.equal(ev.gap_days, 20); assert.equal(ev.prohibited, false); assert.equal(ev.event.payload.lpi_prompt_charge_prohibited, false); assert.equal(ev.event.payload.renewal_daily_rate_cents, "614.754098");
  assert.ok(eventMatches(REG.get(GAP)!.triggerPattern!, ev.event));
  const flag = h.inst(GAP)!; assert.equal(flag.status, "armed"); assert.equal(flag.note, "evaluator:9.4.promptChargeAllowed"); assert.equal(flag.anchorDate, "2028-11-02");
  assert.equal(evaluateGate("9.4.promptChargeAllowed", ev.event.payload).open, true);
  const d = h.svc.decideGapCharge(ev.event.id, on);
  assert.equal(d.action, "prompt_charge"); assert.equal(d.amount_cents, 12295n); assert.equal(d.gap_days, 20); assert.equal(d.event.payload.amount_cents, 12295n); assert.match(String(d.event.payload.decision), /§1024\.37\(e\)\(1\)\(iii\) prompt charge: 20 days × 614\.754098/);
  assert.deepEqual(h.ledger.sets().at(-1)!.lines.map((l) => [l.account.account, l.amountCents, l.ruleRef]), [["corporate_advance", 12295n, "9.4 rule 4 / §1024.37(e)(1)(iii)"], ["corporate_cash", -12295n, "9.4 rule 4 / §1024.37(e)(1)(iii)"]]);
  assert.equal(flag.status, "cancelled"); assert.match(flag.cancelledReason!, /prompt charge: 20 days/);   // "charge or documented waiver" — the decision record closes the flag
  assert.equal(h.events.ofType("insurance.lapse_detected").length, 0);
  // A prohibited state: no prompt charge — the decision record opens a new 9.2 cycle (insurance.lapse_detected → Fpi92Service opens the case with its fresh 45-day clocks).
  const h2 = harness("2026-11-19T14:00:00.000Z", ["9.2", "9.4"]); const svc92 = new Fpi92Service({ events: h2.events, clock: h2.clock, timers: h2.timers }); fpiReactors_9_2(svc92, h2.events);
  charged(h2, { case_id: "fpi-L-94NP", loan_id: "L-94NP", state: "NP" });
  h2.at("2028-11-02T14:00:00.000Z");
  const ev2 = h2.svc.recordGapEvidence({ case_id: "fpi-L-94NP", gap_start: D("2028-10-01"), gap_end: D("2028-10-21"), evidence_id: "doc-gap-2", received_on: D("2028-11-02") });
  assert.equal(ev2.prohibited, true); assert.equal(evaluateGate("9.4.promptChargeAllowed", ev2.event.payload).open, false);
  const d2 = h2.svc.decideGapCharge(ev2.event.id, D("2028-11-02"));
  assert.equal(d2.action, "new_cycle"); assert.equal(d2.amount_cents, null); assert.match(String(d2.event.payload.decision), /prohibited in NP.*new 9\.2 cycle/);
  const lapse = h2.events.ofType("insurance.lapse_detected")[0]!; assert.equal(lapse.loanId, "L-94NP"); assert.equal(lapse.payload.lapse_start, "2028-10-01"); assert.equal(lapse.causationId, d2.event.id);
  const c92 = svc92.openFor("L-94NP")!; assert.equal(c92.status, "first_notice_pending"); assert.equal(c92.lapse_start, "2028-10-01"); assert.equal(c92.basis!.kind, "carrier_cancellation"); assert.equal(c92.basis!.evidence_id, "doc-gap-2");
  assert.equal(h2.inst("INS_FPI_FIRST_NOTICE_SLA_3BD")!.status, "armed");                             // the new cycle's own clocks
  assert.equal(h2.inst(GAP)!.status, "cancelled");
  // No jurisdiction answer on file → attorney review, no charge (§1024.37(e)(1)(iii) "if not prohibited by State or other applicable law"); a period the LPI covered is a 9.5 overlap, not a gap.
  const h3 = harness(); charged(h3, { case_id: "fpi-L-94X", loan_id: "L-94X", state: "XX" }); h3.at("2028-11-02T14:00:00.000Z");
  assert.throws(() => h3.svc.recordGapEvidence({ case_id: "fpi-L-94X", gap_start: D("2028-10-01"), gap_end: D("2028-10-21"), evidence_id: "doc-gap-3", received_on: D("2028-11-02") }), /lpi_prompt_charge_prohibited is not populated for XX.*attorney/);
  assert.throws(() => h3.svc.recordGapEvidence({ case_id: "fpi-L-94X", gap_start: D("2028-09-15"), gap_end: D("2028-10-21"), evidence_id: "doc-gap-4", received_on: D("2028-11-02"), lpi_prompt_charge_prohibited: false }), /precedes the LPI expiration 2028-10-01/);
  assert.equal(h3.timers.byCode(GAP).length, 0);
});
test("9.4-T5: Given RCV estimate drops to $230,000 at review Then renewal coverage $230,000 and tier deductible $2,000.", () => {
  const r = lpiCoverage({ last_known_cents: 25000000n, rcv_cents: 23000000n, upb_cents: 20000000n, state_cap_cents: null });
  assert.equal(r.coverage_cents, 23000000n); assert.equal(r.deductible_cents, 200000n); assert.equal(r.basis, "rcv_over_insurance_cap");   // B-2-01: never above RCV
  assert.equal(tierDeductible(23000000n), 200000n);
  // The A − 60 review on the live cycle: coverage adjusted down from the $250,000 term, the row satisfied, the quote and the notice's cost figure on the new amount, the renewal bound at $230,000.
  const h = harness(); const ren = h.svc.scheduleRenewal(PLACED);
  h.at("2027-08-02T14:00:00.000Z"); h.svc.sweep(D("2027-08-02"));
  assert.throws(() => h.svc.recordRenewalQuote(ren.id, { carrier_quote_cents: null, table_rate_pct: "0.9" }, D("2027-08-02")), /follows the B-2-01 coverage review/);
  const rev = h.svc.reviewCoverage(ren.id, { last_known_cents: 25_000_000n, rcv_cents: 23_000_000n, upb_cents: 20_000_000n }, D("2027-08-02"));
  assert.equal(rev.coverage_cents, 23_000_000n); assert.equal(rev.deductible_cents, 200_000n); assert.equal(rev.basis, "rcv_over_insurance_cap"); assert.equal(rev.adjustment, "down"); assert.match(rev.rationale, /B-2-01 review at A − 60/);
  assert.equal(rev.event.payload.previous_coverage_cents, 25_000_000n); assert.equal(rev.event.payload.coverage_cents, 23_000_000n); assert.equal(rev.event.payload.deductible_cents, 200_000n);
  assert.ok(eventMatches(REG.get(REVIEW60)!.satisfiedPattern!, rev.event)); assert.equal(h.inst(REVIEW60)!.status, "satisfied");
  assert.equal(h.svc.get(ren.id).coverage_cents, 23_000_000n); assert.equal(h.svc.get(ren.id).deductible_cents, 200_000n);
  const q = h.svc.recordRenewalQuote(ren.id, { carrier_quote_cents: null, table_rate_pct: "0.9", rate_table_version: "TX-2027-Q3" }, D("2027-08-02"));
  assert.equal(q.annual_premium_cents, 207_000n); assert.equal(q.is_estimate, true); assert.equal(premiumFromRate(23_000_000n, "0.9"), 207_000n);   // $230,000 × 0.900% — the notice's cost figure reflects the new amount
  const composed = h.svc.composeRenewalNotice(ren.id, { ...FACTS, notice_date: D("2027-08-02") });
  assert.equal(composed.payload.annual_premium_cents, 207_000n); assert.equal(composed.payload.coverage_cents, 23_000_000n); assert.equal(composed.payload.premium_is_estimate, true); assert.equal(composed.payload.estimate_basis_present, true);
  const payload = { ...MS3D_V.samplePayload, ...composed.payload }; assert.equal(evaluateChecklist(asVersion(MS3D_V), payload, render(MS3D_V.source, payload)).passed, true);
  h.svc.recordRenewalNoticeMailed(mailed(PLACED.case_id, "n-ms3d", D("2027-08-02"))); h.at("2027-10-01T14:00:00.000Z");
  const p = h.svc.recordRenewalBound({ renewal_id: ren.id, policy_number: "LPI-TX-0002", premium_cents: 207_000n, effective: D("2027-10-01") });
  assert.equal(p.coverage_amount_cents, 23_000_000n); assert.equal(p.deductible_cents, 200_000n);
  // CA caps the amount at replacement cost even when the last known amount is within 15% of RCV.
  const ca = harness(); const rc = ca.svc.scheduleRenewal({ ...PLACED, case_id: "fpi-L-CA", loan_id: "L-CA", state: "CA" }); ca.at("2027-08-02T14:00:00.000Z");
  const ccov = ca.svc.reviewCoverage(rc.id, { last_known_cents: 25_000_000n, rcv_cents: 24_000_000n, upb_cents: 20_000_000n }, D("2027-08-02"));
  assert.equal(ccov.coverage_cents, 24_000_000n); assert.equal(ccov.event.payload.state_cap_cents, 24_000_000n);
});

test("9.4 rule 2: placement effective 2026-10-01 → anniversary 2027-10-01; notice 2027-08-02 → chargeable 2027-09-16; the $2,250.00 renewal premium is charged on the anniversary", () => {
  const quote = premiumQuote(null, 25000000n, "0.900");                                                // renewal quote from the rate table: $250,000 × 0.900%
  assert.equal(quote.annual_premium_cents, 225000n); assert.equal(premiumFromRate(25000000n, "0.9"), 225000n);
  const rc = renewalCharge(D("2026-10-01"), D("2027-08-02"), quote);
  assert.equal(rc.clocks.anniversary, "2027-10-01"); assert.equal(rc.clocks.chargeable, "2027-09-16"); assert.equal(rc.charge_on, "2027-10-01");
  assert.equal(rc.amount_cents, 225000n); assert.deepEqual(rc.term, { effective: "2027-10-01", expiration: "2028-10-01", premium_cents: 225000n });
  assert.equal(dailyRate(rc.term).toFixed(6), "614.754098");
});
test("9.4 inputs: the 9.2 charge (fpi.charge.assessed) schedules the renewal cycle from the bound placement; the MS-3(D) proof of mailing from the Notice Registry records t2", async () => {
  // The 9.2 worked cycle end to end (9.2-T2): opened 2026-10-02, MS-3(A) 10/05, MS-3(B) 11/04, placed and charged 2026-11-19.
  const h = harness("2026-10-02T14:00:00.000Z", ["9.2", "9.4"]);
  const svc92 = new Fpi92Service({ events: h.events, clock: h.clock, timers: h.timers, ledger: h.ledger }); fpiReactors_9_2(svc92, h.events);
  const c = svc92.openCase({ loan_id: "L-92", kind: "nonrenewed", insurance_type: "hazard", fdpa_required: false, escrowed: false, regx_days_delinquent: 0, cancellation_reason: null, lapse_start: D("2026-10-01"), opened_on: D("2026-10-02"), basis: { kind: "carrier_nonrenewal", evidence_id: "doc-nonrenewal-1" }, state: "TX" });
  h.at("2026-10-05T14:00:00.000Z"); svc92.recordFirstNoticeMailed(mailed(c.case_id, "n-ms3a", D("2026-10-05")));
  h.at("2026-11-04T14:00:00.000Z"); svc92.recordReminderMailed({ ...mailed(c.case_id, "n-ms3b", D("2026-11-04")), variant: "b_no_info" });
  h.at("2026-11-19T14:00:00.000Z"); svc92.evaluateEvidenceWindow(c.case_id, D("2026-11-19"), null);
  const req = svc92.requestPlacement(c.case_id, D("2026-11-19"), COVER, { vendor_id: "LPI-1", whitelist: ["LPI-1"], affiliate: false, fees: [] }, { carrier_quote_cents: null, table_rate_pct: "0.876" });
  svc92.recordLpiBound({ request_id: req.request_id, policy_number: "LPI-TX-0001", premium_cents: 219_000n, effective: D("2026-10-01") });
  const charge = svc92.assessCharge(c.case_id, D("2026-11-19"));
  // The reactor scheduled cycle 1 from the charge: A = effective + 1 year, premium/coverage/deductible from fpi.lpi_bound, state from fpi.case.opened; the annual row is armed.
  const r = h.svc.openFor(c.case_id)!;
  assert.equal(r.origin, "fpi_charge"); assert.equal(r.anniversary_date, "2027-10-01"); assert.equal(r.placement_id, charge.charge.placement_id); assert.deepEqual(r.prior_term, { effective: "2026-10-01", expiration: "2027-10-01", premium_cents: 219_000n });
  assert.equal(r.prior_coverage_cents, 25_000_000n); assert.equal(r.prior_deductible_cents, 200_000n);
  const scheduled = h.events.ofType("fpi.renewal.scheduled")[0]!; assert.equal(scheduled.causationId, charge.event.id); assert.equal(scheduled.payload.notice_mail_by, "2027-08-17");
  assert.equal(h.inst(ANNUAL)!.dueDate, "2027-08-17");
  assert.equal(h.svc.sweep(D("2027-08-01")).length, 0); assert.throws(() => h.svc.openRenewalWindow(r.id, D("2027-08-01")), /window opens 2027-08-02/);
  h.at("2027-08-02T14:00:00.000Z"); h.svc.sweep(D("2027-08-02")); h.svc.reviewCoverage(r.id, COVER, D("2027-08-02")); h.svc.recordRenewalQuote(r.id, { carrier_quote_cents: 225_000n, table_rate_pct: "0.9" }, D("2027-08-02"));
  // The MS-3(D) through the Notice Registry: mail_only (9.4 outputs "first-class mail; always mailed"), production → proof of mailing → fpi.renewal_notice.sent.
  // (src/notices/catalog.ts still lists INS_FPI_RENEWAL_MS3D after the process overrides, so OVERRIDES_9_4's mail_only cannot take effect there yet — a recipient without E-SIGN consent mails either way.)
  const reg = buildRegistry(); publishAuthored(reg);
  const notices = new NoticeService({ registry: reg, events: h.events, clock: h.clock, printMail: new FakePrintMail(), edelivery: new FakeEdelivery() });
  const composed = h.svc.composeRenewalNotice(r.id, { ...FACTS, notice_date: D("2027-08-02") });
  const n = notices.render({ templateCode: MS3D, loanId: "L-92", recipients: [{ partyId: "B1", name: "Bea Borrower", mailingAddress: FACTS.borrower_address }], payload: { ...reg.activeVersion(MS3D, D("2027-08-02"))!.samplePayload, ...composed.payload }, asOf: D("2027-08-02") });
  assert.equal(n.status, "rendered"); await notices.send(n.id);
  assert.equal(n.channelDecision![0]!.channel, "mail_first_class");
  notices.recordMailed(n.id, 1, "2027-08-02T18:00:00.000Z", "POM-ms3d");
  const sent = h.events.ofType("fpi.renewal_notice.sent")[0]!; assert.equal(sent.payload.notice_id, n.id); assert.equal(sent.payload.renewal_notice_mailed_at, "2027-08-02"); assert.equal(sent.payload.proof_of_mailing_id, "POM-ms3d");
  assert.equal(h.svc.get(r.id).status, "notice_sent"); assert.equal(h.inst(ANNUAL, 0)!.status, "satisfied"); assert.equal(h.inst(GATE45)!.dueDate, "2027-09-16");
  assert.equal(h.events.ofType("fpi.inbound.rejected").length, 0);
  // Payoff before A cancels the renewal and its clocks (edge cases).
  h.events.append({ type: "loan.paid_in_full", loanId: "L-92", actor: { kind: "system", id: "payoff" }, payload: {} });
  assert.equal(h.svc.get(r.id).status, "closed_other"); assert.equal(h.inst(GATE45)!.status, "cancelled"); assert.equal(h.inst(ANNUAL)!.status, "cancelled");
  assert.equal(h.events.ofType("fpi.renewal.closed")[0]!.payload.closed_reason, "closed_other");
});
test("9.4 events: every 9.4 registry row is armed by an event the renewal service appends and closed by the one it names", () => {
  const h = harness(); const r = windowOpen(h);
  h.svc.recordRenewalNoticeMailed(mailed(PLACED.case_id, "n-ms3d", D("2027-08-02")));
  h.at("2027-10-01T14:00:00.000Z"); h.svc.recordRenewalBound({ renewal_id: r.id, policy_number: "LPI-0002", premium_cents: 225_000n, effective: D("2027-10-01") }); h.svc.assessRenewalCharge(r.id, D("2027-10-01"));
  const by = (code: string) => h.timers.byCode(code);
  for (const code of [ANNUAL, GATE45, REVIEW60]) assert.ok(by(code).length >= 1, code);
  const find = (id: string): DomainEvent => h.events.all().find((e) => e.id === id)!;
  assert.equal(find(by(ANNUAL)[0]!.armedByEventId).type, "fpi.renewal.scheduled"); assert.equal(find(by(ANNUAL)[0]!.satisfiedByEventId!).type, "fpi.renewal_notice.sent");
  assert.equal(find(by(GATE45)[0]!.armedByEventId).type, "fpi.renewal_notice.sent"); assert.equal(find(by(GATE45)[0]!.satisfiedByEventId!).type, "fpi.renewal.charged");
  assert.equal(find(by(REVIEW60)[0]!.armedByEventId).type, "fpi.anniversary.approaching"); assert.equal(find(by(REVIEW60)[0]!.satisfiedByEventId!).type, "fpi.renewal.coverage_reviewed");
  assert.deepEqual(by(ANNUAL).map((t) => t.status), ["satisfied", "armed"]);                           // recurring: re-armed for 2028-10-01 by the notice, not by the next-term schedule
  assert.deepEqual(h.timers.open().map((t) => t.code), [ANNUAL]);
});
