// 7.2 ARM interest rate adjustment notice
// spec/sections/07-compliance-notices-disclosures/7-2-arm-interest-rate-adjustment-notice.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, addDays } from "../../kernel/calendar/date.ts";
import { zonedEpochMs, toIso } from "../../kernel/calendar/zoned.ts";
import { MemoryEventStore, FixedClock, SYSTEM, eventMatches, type Actor, type DomainEvent } from "../../kernel/events/index.ts";
import { TimerEngine } from "../../kernel/timers/engine.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import { EntityStore, type ToolRuntime } from "../../app/tools.ts";
import { EscalationService } from "../../app/escalations.ts";
import type { CommandContext } from "../../app/commands.ts";
import { SECTION_07_TOOLS } from "../../app/tools/section07.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { NoticeService } from "../../notices/service.ts";
import { FakePrintMail, FakeEdelivery } from "../../infra/integrations/delivery.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";
import type { Recipient } from "../../notices/channel.ts";
import { newConsent, verify } from "./esign.ts";
import { indexDate, selectIndex, newRate, newPayment, noticeWindow, sendCheck } from "./arm.ts";
import { armNoticeSelection, buydownStepNotice, marginErrorCorrection, scheduledUpbAfter, fdcpaCeaseArmNotice, indexCaptureFallback, ch13PaymentChange, armNoticeChannel, computeArmAdjustment, verifyArmAdjustment, armNoticeFigures, rateChangeInvestorEvent } from "./ops.ts";
import * as O from "./ops-7-2.ts";

// ---- rig: event store + TimerEngine (7.2 rows) + entity store + Notice Registry service with fake delivery ports ----
class MemStore implements O.CaseStore {
  private readonly rows = new Map<string, { id: string; data: Record<string, unknown> }>();
  get(kind: string, id: string) { return this.rows.get(`${kind} ${id}`); }
  list(kind: string, where: (d: Record<string, unknown>) => boolean = () => true) { return [...this.rows.entries()].filter(([k, r]) => k.startsWith(`${kind} `) && where(r.data)).map(([, r]) => r); }
  put(kind: string, id: string, data: Record<string, unknown>) { const prev = this.get(kind, id); const r = { id, data: { ...(prev?.data ?? {}), ...data } }; this.rows.set(`${kind} ${id}`, r); return r; }
}
const DISCLOSURES: Actor = { kind: "agent", id: "disclosures" };
const CONTACT = { servicer_phone: "(800) 555-0100", servicer_address: "PO Box 1, Testville TX 75001", exclusive_address: "PO Box 2, Testville TX 75001" };
const BORROWER: Recipient = { partyId: "B-1", name: "Alex Borrower", mailingAddress: "1 Test St, Testville TX 75001" };
const ET = "America/New_York";
function rig(day: string, hhmm = "14:00") {
  const clock = new FixedClock(toIso(zonedEpochMs(D(day), hhmm, ET))); const events = new MemoryEventStore(clock);
  const engine = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["7.2"] });
  const store = new MemStore(); const reg = buildRegistry(); publishAuthored(reg);
  const pm = new FakePrintMail(); const ed = new FakeEdelivery();
  const notices = new NoticeService({ registry: reg, events, clock, printMail: pm, edelivery: ed });
  const deps = (): O.OpsDeps => ({ events, store, actor: DISCLOSURES, now: clock.now() });
  const at = (d: string, h = "14:00"): void => clock.set(toIso(zonedEpochMs(D(d), h, ET)));
  const status = (code: string, n = 0) => engine.byCode(code)[n]?.status ?? "not armed";
  const sentTemplates = (loanId: string) => events.byLoan(loanId).filter((e) => e.type === "notice.sent").map((e) => String(e.payload.template));
  return { clock, events, engine, store, notices, pm, ed, deps, at, status, sentTemplates };
}
type Rig = ReturnType<typeof rig>;
// Plan 4927 worked example: note 5.750%, margin 2.750, $400,000.00, 360 months, first payment 2021-12-01, first change 2026-11-01 (5/6, 2/1/5 caps).
const LOAN = "L-4927";
const PLAN_4927 = { loan_id: LOAN, product: "ARM", fnma_arm_plan: "4927", index_type: "SOFR_30D_AVG", margin_pct: "2.750", lookback_days: 45, first_change_date: "2026-11-01", adjustment_period_months: 6, initial_cap_pct: "2.000", periodic_cap_pct: "1.000", lifetime_cap_pct: "5.000", initial_note_rate_pct: "5.750", current_pi_cents: 233429n, original_upb_cents: 40000000n, first_payment_due: "2021-12-01", term_months: 360, consummation_date: "2021-10-15", escrow_cents: 61250n } as const;
const BASE = { margin_pct: "2.750", prior_rate_pct: "5.750", initial_note_rate_pct: "5.750", initial_cap_pct: "2.000", periodic_cap_pct: "1.000", lifetime_cap_pct: "5.000", first_change: true };
const nyfed = (effectiveDate: string, average30day: string) => ({ effectiveDate, type: "SOFRAI", average30day, average90day: "3.70000", average180day: "3.90000", index: "1.12000000", revisionIndicator: "" });
const SEPT_PRINTS = [nyfed("2026-09-16", "3.64500"), nyfed("2026-09-17", "3.64883"), nyfed("2026-09-18", "3.65000")];
/** Board on 2026-06-01, open the window on 2026-08-03, capture the September prints and calculate + verify on `calcOn`. */
function throughVerification(r: Rig, terms: Record<string, unknown> = { ...PLAN_4927 }, prints = SEPT_PRINTS, calcOn = "2026-09-17") {
  r.at("2026-06-01"); const boarded = O.boardArmTerms(r.deps(), terms);
  r.at("2026-08-03"); O.openNoticeWindow(r.deps(), LOAN, D("2026-11-01"));
  r.at(calcOn); for (const p of prints) O.captureIndex(r.deps(), p);
  const calc = O.calculateAdjustment(r.deps(), LOAN, D("2026-11-01"));
  const ver = O.verifyAdjustment(r.deps(), LOAN, D("2026-11-01"));
  return { boarded, calc, ver };
}

test("7.2-T1: Given Plan 4927 with change date 2026-11-01, look-back 45, then `index_date` = 2026-09-17 and the value with the latest publication ≤ that date is used.", () => {
  assert.equal(indexDate(D("2026-11-01"), 45), "2026-09-17");
  const obs = [{ effective_date: D("2026-09-16"), value: "3.64500" }, { effective_date: D("2026-09-17"), value: "3.64883" }, { effective_date: D("2026-09-18"), value: "3.65000" }];
  assert.equal(selectIndex(obs, D("2026-09-17"))!.value, "3.64883");
  assert.equal(selectIndex(obs.filter((o) => o.effective_date !== "2026-09-17"), D("2026-09-17"))!.value, "3.64500");   // no Sept 17 print → the latest earlier publication
  assert.equal(selectIndex(obs, D("2026-09-15")), null);
  // the boarded schedule row carries the index date; the index-feed ingestion captures the NY Fed prints and the calculation takes the Sept 17 print
  const r = rig("2026-06-01"); const { boarded, calc } = throughVerification(r);
  assert.equal(boarded.rows[0]!.index_date, "2026-09-17"); assert.equal(boarded.rows[0]!.first_new_payment_due, "2026-12-01"); assert.equal(boarded.rows.length, 50);   // every 6 months to 2051-11-01
  assert.equal(boarded.armed!.event.payload.index_date, "2026-09-17"); assert.equal(boarded.armed!.event.payload.notice_kind, "c_60_120");
  assert.equal(calc.adjustment.index_value, "3.64883"); assert.equal(calc.adjustment.index_publication_date, "2026-09-17"); assert.equal(calc.adjustment.index_capture_id, "SOFR_30D_AVG:2026-09-17:1"); assert.equal(calc.event.payload.index_value, "3.64883");
  const late = rig("2026-06-01"); late.at("2026-06-01"); O.boardArmTerms(late.deps(), { ...PLAN_4927 }); late.at("2026-09-18");
  for (const p of SEPT_PRINTS.filter((p) => p.effectiveDate !== "2026-09-17")) O.captureIndex(late.deps(), p);
  assert.equal(O.calculateAdjustment(late.deps(), LOAN, D("2026-11-01")).adjustment.index_value, "3.64500");   // no Sept 17 publication → Sept 16 (the Sept 18 print is after the index date)
  const none = rig("2026-06-01"); O.boardArmTerms(none.deps(), { ...PLAN_4927 }); none.at("2026-09-17");
  assert.throws(() => O.calculateAdjustment(none.deps(), LOAN, D("2026-11-01")), /SM_ARM_INDEX_CAPTURE_T45: no SOFR_30D_AVG publication on or before the index date 2026-09-17/);
  assert.equal(O.captureIndex(r.deps(), nyfed("2026-09-17", "3.64883")).duplicate, true);   // idempotent upsert keyed by (type, effectiveDate)
  const rev = O.captureIndex(r.deps(), { ...nyfed("2026-09-17", "3.64890"), revisionIndicator: "R" }); assert.equal(rev.revision, true); assert.equal(rev.capture.revision_of, "SOFR_30D_AVG:2026-09-17:1");
});
test("7.2-T2: Given index 3.64883 and margin 2.750, then unrounded 6.39883 rounds to 6.375%; given 6.4375 exactly (midpoint), then the result follows `rounding_rule` (default half-down → 6.375%; half-up → 6.500%) and the case is flagged for QC.", () => {
  const r = newRate({ ...BASE, index_pct: "3.64883" }); assert.equal(r.unrounded_pct, "6.39883"); assert.equal(r.new_rate_pct, "6.375"); assert.equal(r.bound, "none"); assert.equal(r.midpoint_flag, false);
  const mid = newRate({ ...BASE, index_pct: "3.6875" }); assert.equal(mid.unrounded_pct, "6.43750"); assert.equal(mid.new_rate_pct, "6.375"); assert.equal(mid.midpoint_flag, true);
  assert.equal(newRate({ ...BASE, index_pct: "3.6875", rounding: "half_up" }).new_rate_pct, "6.500");
  assert.equal(verifyArmAdjustment({ ...BASE, index_pct: "3.6875", rounding: "half_up", expected_upb_cents: 37104886n, remaining_term_months: 300 }).new_rate_pct, "6.500");   // engine B follows the same rule
  // through the cycle: the boarded `rounding_rule` drives the engines and the midpoint is flagged for the qc-audit sample
  const dn = rig("2026-06-01"); const { calc } = throughVerification(dn, { ...PLAN_4927 }, [nyfed("2026-09-17", "3.68750")]);
  assert.equal(calc.adjustment.unrounded_pct, "6.43750"); assert.equal(calc.adjustment.new_rate_pct, "6.375"); assert.equal(calc.adjustment.midpoint_flag, true); assert.equal(calc.adjustment.qc_sample, true); assert.equal(calc.event.payload.midpoint_flag, true); assert.equal(calc.event.payload.qc_sample, true);
  const up = rig("2026-06-01"); const half_up = throughVerification(up, { ...PLAN_4927, rounding_rule: "nearest_eighth_half_up" }, [nyfed("2026-09-17", "3.68750")]);
  assert.equal(half_up.calc.adjustment.new_rate_pct, "6.500"); assert.equal(half_up.ver.agrees, true);
  const std = rig("2026-06-01"); assert.equal(throughVerification(std).calc.adjustment.qc_sample, false);
  assert.throws(() => O.parseArmTerms({ ...PLAN_4927, rounding_rule: "banker" }), /rounding_rule banker/);
});
test("7.2-T3: Given prior rate 5.750, initial cap 2.000, index 5.10000, then new rate = 7.750 (cap-bound), `cap_test.applied = initial`, and the notice contains the cap statement.", async () => {
  const capped = newRate({ ...BASE, index_pct: "5.10000" }); assert.equal(capped.unrounded_pct, "7.85000"); assert.equal(capped.new_rate_pct, "7.750"); assert.equal(capped.bound, "initial");
  const reg = buildRegistry(); publishAuthored(reg);
  const v = reg.activeVersion("NTC_REGZ_20C_ARM_ADJ", D("2026-09-20"))!;
  const payload = { ...v.samplePayload, new_rate_pct: "7.750", uncapped_rate_pct: "7.875", cap_applied: true, new_pi_cents: 280264n, total_payment_cents: 341514n };
  const r = render(v.source, payload);
  assert.match(r.text, /Rate limits: your rate cannot increase or decrease by more than 2\.000% at this change or ever exceed 10\.750%; it will never fall below 2\.750%\. Your rate would have been 7\.875% but the cap limits it to 7\.750%\./);
  const c = evaluateChecklist(v, payload, r); assert.equal(c.passed, true); assert.equal(c.results.find((x) => x.rule_id === "v-caps")!.passed, true);
  assert.equal(newRate({ ...BASE, index_pct: "0.1", first_change: false }).bound, "periodic");
  assert.equal(newRate({ ...BASE, index_pct: "9.0", first_change: false, prior_rate_pct: "10.000" }).new_rate_pct, "10.750");   // lifetime 5.750 + 5.000
  // through the cycle: cap_test records the binding limit and the rendered (c) notice carries the cap statement with the would-have-been rate
  const g = rig("2026-06-01"); const { calc } = throughVerification(g, { ...PLAN_4927 }, [nyfed("2026-09-17", "5.10000")]);
  assert.equal(calc.adjustment.new_rate_pct, "7.750"); assert.equal(calc.adjustment.rounded_pct, "7.875"); assert.equal(calc.adjustment.cap_test.applied, "initial"); assert.deepEqual([...calc.adjustment.cap_test.periodic_limit], ["3.750", "7.750"]); assert.equal(calc.adjustment.cap_test.lifetime_limit, "10.750"); assert.equal(calc.adjustment.cap_test.foregone, "0");
  assert.equal(calc.adjustment.new_pi_cents, 280264n); assert.equal(calc.adjustment.qc_sample, true);   // cap-bound → qc-audit sample
  g.at("2026-09-21"); const sent = await O.sendAdjustmentNotice(g.deps(), g.notices, { loan_id: LOAN, change_date: D("2026-11-01"), recipients: [BORROWER], contact: CONTACT });
  assert.equal(sent.template, "NTC_REGZ_20C_ARM_ADJ");
  assert.match(g.notices.get(sent.notice_id!).rendered.text, /Your rate would have been 7\.875% but the cap limits it to 7\.750%\./);
});
test("7.2-T4: Given UPB $371,048.86, 300 months, 6.375%, then new P&I = $2,476.44 (round-half-up); engine B must equal engine A.", async () => {
  assert.equal(newPayment(37104886n, "6.375", 300), 247644n);
  const input = { ...BASE, index_pct: "3.64883", expected_upb_cents: 37104886n, remaining_term_months: 300 };
  const a = computeArmAdjustment(input); const b = verifyArmAdjustment(input, a);
  assert.equal(a.engine, "A"); assert.equal(b.engine, "B"); assert.equal(a.new_pi_cents, 247644n); assert.equal(b.new_pi_cents, 247644n); assert.equal(b.agrees, true); assert.equal(b.discrepancy, null);
  assert.equal(evaluateGate("7.2.dualCalculationMatches", { engine_a_payment_cents: a.new_pi_cents, engine_b_payment_cents: b.new_pi_cents, engine_a_rate: a.new_rate_pct, engine_b_rate: b.new_rate_pct }).open, true);
  const off = verifyArmAdjustment(input, { ...a, new_pi_cents: 247645n }); assert.equal(off.agrees, false); assert.match(off.discrepancy!, /payment 247645 vs 247644/);
  assert.equal(evaluateGate("7.2.dualCalculationMatches", { engine_a_payment_cents: 247645n, engine_b_payment_cents: b.new_pi_cents, engine_a_rate: a.new_rate_pct, engine_b_rate: b.new_rate_pct }).open, false);
  // through the cycle: the F-1-01 expected UPB and remaining term come from the boarded schedule; `arm.adjustment.calculated` arms SM_ARM_DUAL_CALC_VERIFY_T0 and engine B's agreement (`arm.adjustment.verified`) closes it
  const r = rig("2026-06-01"); const { calc, ver } = throughVerification(r);
  assert.equal(calc.adjustment.expected_upb_cents, 37104886n); assert.equal(calc.adjustment.remaining_term_months, 300); assert.equal(calc.adjustment.new_pi_cents, 247644n); assert.equal(calc.adjustment.engine_a.engine, "A");
  assert.equal(ver.agrees, true); assert.equal(ver.adjustment.engine_b!.engine, "B"); assert.equal(ver.adjustment.verified_by, "engine_b"); assert.equal(ver.event.type, "arm.adjustment.verified");
  assert.equal(evaluateGate("7.2.dualCalculationMatches", ver.event.payload).open, true);
  assert.equal(r.status("SM_ARM_DUAL_CALC_VERIFY_T0"), "satisfied"); assert.equal(r.engine.byCode("SM_ARM_DUAL_CALC_VERIFY_T0")[0]!.note, "evaluator:7.2.dualCalculationMatches");
  // a tampered engine A figure never verifies: `arm.adjustment.discrepancy`, the gate stays armed, ops review opens
  const t = rig("2026-06-01"); t.at("2026-06-01"); O.boardArmTerms(t.deps(), { ...PLAN_4927 }); t.at("2026-09-17"); for (const p of SEPT_PRINTS) O.captureIndex(t.deps(), p);
  const c2 = O.calculateAdjustment(t.deps(), LOAN, D("2026-11-01"));
  t.store.put("arm_adjustments", O.rowId(LOAN, D("2026-11-01")), { ...c2.adjustment, engine_a: { ...c2.adjustment.engine_a, new_pi_cents: 247645n } });
  const opened: { kind: string; payload?: Record<string, unknown> }[] = [];
  const bad = O.verifyAdjustment(t.deps(), LOAN, D("2026-11-01"), { escalations: { open: (i) => { opened.push(i); return { id: "esc-1" }; } } });
  assert.equal(bad.agrees, false); assert.match(bad.discrepancy!, /payment 247645 vs 247644/); assert.equal(bad.event.type, "arm.adjustment.discrepancy"); assert.equal(bad.escalation_id, "esc-1"); assert.equal(opened[0]!.kind, "human_agent");
  assert.equal(t.status("SM_ARM_DUAL_CALC_VERIFY_T0"), "armed"); assert.equal(evaluateGate("7.2.dualCalculationMatches", bad.event.payload).open, false);
  await assert.rejects(() => O.sendAdjustmentNotice(t.deps(), t.notices, { loan_id: LOAN, change_date: D("2026-11-01"), recipients: [BORROWER], contact: CONTACT }), /SM_ARM_DUAL_CALC_VERIFY_T0: adjustment 2026-11-01 on L-4927 is discrepancy, not verified/);
});
test("7.2-T5: Given first new payment due 2026-12-01, then the not-before gate opens 2026-08-03, the deadline is 2026-10-02, and a send on 2026-10-03 breaches with sev-1.", async () => {
  const w = noticeWindow(D("2026-12-01"), D("2026-11-01"), 45);
  assert.deepEqual([w.not_before, w.deadline, w.sendable_from], ["2026-08-03", "2026-10-02", "2026-09-17"]);
  assert.deepEqual(sendCheck(D("2026-10-03"), w, { gate: "REGZ_1026_20C_ADJ_NOTICE_NOT_BEFORE_120", deadline: "REGZ_1026_20C_ADJ_NOTICE_60" }), { allowed: true, blocked_by: null, breach: { timer: "REGZ_1026_20C_ADJ_NOTICE_60", severity: 1, days_late: 1 } });
  assert.equal(sendCheck(D("2026-08-02"), w, { gate: "REGZ_1026_20C_ADJ_NOTICE_NOT_BEFORE_120", deadline: "REGZ_1026_20C_ADJ_NOTICE_60" }).blocked_by, "REGZ_1026_20C_ADJ_NOTICE_NOT_BEFORE_120");
  // the schedule row the boarding emits arms both clocks on `first_new_payment_due`
  const r = rig("2026-06-01"); const boarded = O.boardArmTerms(r.deps(), { ...PLAN_4927 });
  assert.equal(boarded.armed!.event.type, "arm.schedule.row_created"); assert.equal(boarded.armed!.event.payload.first_new_payment_due, "2026-12-01"); assert.equal(boarded.armed!.event.payload.notice_window_open, "2026-08-03"); assert.equal(boarded.armed!.event.payload.notice_due_by, "2026-10-02");
  const gate = r.engine.byCode("REGZ_1026_20C_ADJ_NOTICE_NOT_BEFORE_120")[0]!; const dl = r.engine.byCode("REGZ_1026_20C_ADJ_NOTICE_60")[0]!;
  assert.equal(gate.dueDate, "2026-08-03"); assert.equal(dl.dueDate, "2026-10-02"); assert.equal(r.engine.byCode("SM_ARM_INDEX_CAPTURE_T45")[0]!.dueDate, "2026-09-17");
  r.at("2026-08-02"); const early = O.openNoticeWindow(r.deps(), LOAN, D("2026-11-01")); assert.equal(early.opened, false); assert.equal(early.opens_on, "2026-08-03"); assert.equal(gate.status, "armed");
  r.at("2026-08-03"); const open = O.openNoticeWindow(r.deps(), LOAN, D("2026-11-01")); assert.equal(open.opened, true); assert.equal(open.event!.type, "arm.adjustment.notice_window_opened"); assert.equal(open.event!.payload.kind, "c"); assert.equal(gate.status, "satisfied");
  assert.equal(O.openNoticeWindow(r.deps(), LOAN, D("2026-11-01")).already_open, true);
  r.at("2026-09-17"); for (const p of SEPT_PRINTS) O.captureIndex(r.deps(), p); O.calculateAdjustment(r.deps(), LOAN, D("2026-11-01")); O.verifyAdjustment(r.deps(), LOAN, D("2026-11-01"));
  r.events.append({ type: "notice.sent", loanId: LOAN, actor: SYSTEM, payload: { template: "NTC_REGZ_41_STMT_DELQ" } }); assert.equal(dl.status, "armed");   // a periodic statement never closes the (c) deadline
  r.at("2026-10-03"); const breaches = r.engine.evaluate(r.clock.now());
  const b = breaches.find((x) => x.def.code === "REGZ_1026_20C_ADJ_NOTICE_60")!; assert.equal(b.severity, 1); assert.equal(dl.status, "breached");
  // the late (c) notice still goes (decision 5: the payment change defers one cycle, the rate still changes on the change date, the servicer funds the shortage)
  const sent = await O.sendAdjustmentNotice(r.deps(), r.notices, { loan_id: LOAN, change_date: D("2026-11-01"), recipients: [BORROWER], contact: CONTACT });
  assert.deepEqual(sent.breach, { timer: "REGZ_1026_20C_ADJ_NOTICE_60", severity: 1, days_late: 1 }); assert.equal(sent.late, true); assert.equal(sent.payment_change_deferred, true); assert.equal(sent.payment_effective_due, "2027-01-01"); assert.equal(sent.days_before_first_payment, 90);
  assert.equal(dl.status, "satisfied_late"); assert.equal(sent.event!.payload.breach_timer, "REGZ_1026_20C_ADJ_NOTICE_60");
  r.at("2026-11-01"); const eff = O.makeEffective(r.deps(), LOAN, D("2026-11-01"));
  assert.equal(eff.terms.current_rate_pct, "6.375"); assert.equal(eff.servicer_shortage_cents, 247644n - 233429n); assert.equal(eff.events[1]!.payload.payment_effective_due, "2027-01-01");
  // a send before the gate opens is refused
  const e = rig("2026-06-01"); O.boardArmTerms(e.deps(), { ...PLAN_4927 }); e.at("2026-07-31"); O.captureIndex(e.deps(), nyfed("2026-07-31", "3.64381")); e.at("2026-08-01"); O.calculateAdjustment(e.deps(), LOAN, D("2026-11-01")); O.verifyAdjustment(e.deps(), LOAN, D("2026-11-01"));
  e.at("2026-08-02"); await assert.rejects(() => O.sendAdjustmentNotice(e.deps(), e.notices, { loan_id: LOAN, change_date: D("2026-11-01"), recipients: [BORROWER], contact: CONTACT }), /REGZ_1026_20C_ADJ_NOTICE_NOT_BEFORE_120: send blocked before 2026-08-03/);
});
test("7.2-T6: Given a legacy loan with 1-month adjustments, then the 25-day deadline applies (2026-11-06 for a 2026-12-01 payment).", () => {
  assert.equal(noticeWindow(D("2026-12-01"), D("2026-11-01"), 45, true).deadline, "2026-11-06");
  const reg = buildRegistry(); publishAuthored(reg);
  const v = reg.activeVersion("NTC_REGZ_20C_ARM_ADJ", D("2026-10-20"))!;
  const frequent = { ...v.samplePayload, notice_kind: "c_25_120", days_before_first_payment: 40 };
  assert.equal(evaluateChecklist(v, frequent, render(v.source, frequent)).passed, true);                                   // 25–120 for ≤60-day adjusters
  const standard = { ...v.samplePayload, notice_kind: "c_60_120", days_before_first_payment: 40 };
  assert.ok(evaluateChecklist(v, standard, render(v.source, standard)).blocking.some((b) => b.rule_id === "timing-window"));
  // the boarded legacy terms classify the row `c_25_120`: the 25-day row arms, the −60 sev-1 row does not (§1026.20(c)(2): 25–120 for adjustments every 60 days or more frequently)
  const r = rig("2026-06-01"); const legacy = O.boardArmTerms(r.deps(), { ...PLAN_4927, fnma_arm_plan: null, index_type: "CMT_1Y", adjustment_period_months: 1, consummation_date: "2004-10-15", first_payment_due: "2004-12-01", term_months: 360, schedule_basis: { upb_cents: 37104886n, rate_pct: "5.750", pi_cents: 233429n, from_due_date: "2026-11-01" } });
  assert.equal(legacy.rows[0]!.notice_kind, "c_25_120"); assert.equal(legacy.rows[0]!.notice_due_by, "2026-11-06"); assert.equal(legacy.armed!.event.payload.notice_kind, "c_25_120"); assert.equal(legacy.armed!.event.payload.frequent_adjuster, true);
  assert.equal(r.engine.byCode("REGZ_1026_20C_FREQ_ADJ_NOTICE_25")[0]!.dueDate, "2026-11-06"); assert.equal(r.engine.byCode("REGZ_1026_20C_ADJ_NOTICE_NOT_BEFORE_120")[0]!.dueDate, "2026-08-03");
  assert.equal(r.engine.byCode("REGZ_1026_20C_ADJ_NOTICE_60").length, 0, "the −60 row must not arm on a frequent adjuster");
  // pre-2015 loans with a look-back under 45 days are 25-day loans too; a standard plan is not
  assert.equal(O.noticeKindFor({ term_months: 360, consummation_date: D("2014-06-01"), initial_disclosure_estimate: false, adjustment_period_months: 12, lookback_days: 30 }, false, D("2026-11-01"), D("2026-12-01")), "c_25_120");
  assert.equal(O.noticeKindFor({ term_months: 360, consummation_date: D("2021-10-15"), initial_disclosure_estimate: false, adjustment_period_months: 6, lookback_days: 45 }, false, D("2026-11-01"), D("2026-12-01")), "c_60_120");
  assert.equal(O.noticeKindFor({ term_months: 12, consummation_date: D("2026-01-15"), initial_disclosure_estimate: false, adjustment_period_months: 6, lookback_days: 45 }, true, D("2026-07-01"), D("2026-08-01")), "fnma_only");   // (c)(1)(ii)(A)
});
test("7.2-T7: Given the adjustment verified on 2026-09-17, then the `rate_payment_change` investor event is emitted and 5.1's LAR 83 timer is due 2026-09-24 20:00 ET.", () => {
  const r0 = rateChangeInvestorEvent({ verified_on: D("2026-09-17"), calculation_date: D("2026-09-17"), first_new_payment_due: D("2026-12-01"), index_value: "3.64883", new_rate_pct: "6.375", servicing_fee_pct: "0.250", new_pi_cents: 247644n });
  assert.equal(r0.event.type, "investor_events.projected"); assert.equal(r0.event.payload.event_type, "rate_payment_change"); assert.equal(r0.event.payload.effective_with_payment_due, "1226"); assert.equal(r0.event.payload.pass_through_rate_pct, "6.125"); assert.equal(r0.event.payload.new_payment_cents, 247644n);
  assert.equal(toIso(r0.lar83_due_at_ms), toIso(zonedEpochMs(D("2026-09-24"), "20:00", "America/New_York")));
  // through the cycle: verification on 2026-09-17 emits the investor event; the LAR 83 clock armed by `arm.adjustment.calculated{calculation_date}` is due BD5 20:00 ET and closes on Fannie Mae's acceptance
  const r = rig("2026-06-01"); const { ver } = throughVerification(r);
  assert.equal(ver.adjustment.verified_on, "2026-09-17"); assert.equal(ver.investor_event!.type, "investor_events.projected");
  assert.equal(ver.investor_event!.payload.event_type, "rate_payment_change"); assert.equal(ver.investor_event!.payload.effective_with_payment_due, "1226"); assert.equal(ver.investor_event!.payload.new_payment_cents, 247644n); assert.equal(ver.investor_event!.payload.index_value, "3.64883"); assert.equal(ver.investor_event!.payload.legacy_record, 83);
  assert.equal(toIso(ver.lar83_due_at_ms!), "2026-09-25T00:00:00.000Z");   // 20:00 EDT
  const t = r.engine.byCode("FNMA_IRM_LAR83_RATE_CHANGE_BD5")[0]!; assert.equal(t.dueDate, "2026-09-24"); assert.equal(toIso(t.dueAt!), "2026-09-25T00:00:00.000Z"); assert.equal(t.anchorDate, "2026-09-17");
  r.at("2026-09-18"); const ack = O.ingestLar83Feedback(r.deps(), LOAN, { record: "83", status: "accepted", effective_with_payment_due: "1226", fnma_loan_number: "1234567890" });
  assert.equal(ack.status, "accepted"); assert.equal(ack.event.type, "investor_events.accepted"); assert.equal(ack.event.payload.event_type, "rate_payment_change"); assert.equal(ack.projected_event_id, ver.investor_event!.id); assert.equal(t.status, "satisfied");
  // a reject is worked as a 5.1 exception (single-LAR portal task); the timer stays open; malformed feedback is refused
  const j = rig("2026-06-01"); throughVerification(j); const tasks: { kind: string; ownerRole?: string; payload?: Record<string, unknown> }[] = [];
  const rej = O.ingestLar83Feedback(j.deps(), LOAN, { record: 83, status: "rejected", effective_with_payment_due: "1226", reason: "E123 rate out of range" }, { open: (i) => { tasks.push(i); return { id: "task-1" }; } });
  assert.equal(rej.status, "rejected"); assert.equal(rej.event.type, "investor_events.rejected"); assert.equal(rej.portal_task_id, "task-1"); assert.equal(tasks[0]!.ownerRole, "fnma_portal_operator"); assert.equal(tasks[0]!.payload!.task, "single_lar_entry"); assert.equal(j.status("FNMA_IRM_LAR83_RATE_CHANGE_BD5"), "armed");
  assert.throws(() => O.ingestLar83Feedback(j.deps(), LOAN, { record: "89", status: "accepted", effective_with_payment_due: "1226" }), /record 89 is not 83/);
  assert.throws(() => O.ingestLar83Feedback(j.deps(), LOAN, { record: "83", status: "accepted", effective_with_payment_due: "0127" }), /no projected rate_payment_change event effective 0127/);
});
test("7.2-T8: Given a rate change with an unchanged payment (payment-cap plan), then `NTC_FNMA_C2_1_02_RATE_CHANGE` is sent ≥ 25 days before the change date and no Reg Z (c) notice is generated.", async () => {
  const s = armNoticeSelection({ rate_changed: true, payment_changed: false, change_date: D("2026-11-01") });
  assert.equal(s.regz_c_notice, false); assert.equal(s.fnma_notice, "NTC_FNMA_C2_1_02_RATE_CHANGE"); assert.equal(s.send_by, "2026-10-07");
  assert.equal(armNoticeSelection({ rate_changed: true, payment_changed: true, change_date: D("2026-11-01") }).regz_c_notice, true);
  assert.equal(armNoticeSelection({ rate_changed: false, payment_changed: false, change_date: D("2026-11-01") }).fnma_notice, null);
  // a legacy payment-cap plan (monthly rate changes, annual payment changes) boarded after its Oct 1 change: the Nov 1 change moves the rate only
  const r = rig("2026-10-05");
  const legacy = O.boardArmTerms(r.deps(), { ...PLAN_4927, fnma_arm_plan: null, index_type: "CMT_1Y", adjustment_period_months: 1, payment_change_period_months: 12, first_change_date: "2026-10-01", consummation_date: "2004-10-15", first_payment_due: "2004-12-01", schedule_basis: { upb_cents: 37104886n, rate_pct: "5.750", pi_cents: 233429n, from_due_date: "2026-11-01" } });
  assert.equal(legacy.armed!.row.change_date, "2026-11-01"); assert.equal(legacy.armed!.row.notice_kind, "c_25_120");
  O.captureIndex(r.deps(), { index_type: "CMT_1Y", effective_date: "2026-09-17", value: "3.10000", source: "frb_h15" });
  const calc = O.calculateAdjustment(r.deps(), LOAN, D("2026-11-01"));
  assert.equal(calc.adjustment.new_rate_pct, "5.875"); assert.equal(calc.adjustment.new_pi_cents, 233429n); assert.equal(calc.adjustment.payment_change_deferred_to_payment_change_date, true);
  assert.equal(O.verifyAdjustment(r.deps(), LOAN, D("2026-11-01")).agrees, true);
  r.at("2026-10-06"); const sent = await O.sendAdjustmentNotice(r.deps(), r.notices, { loan_id: LOAN, change_date: D("2026-11-01"), recipients: [BORROWER], contact: CONTACT });
  assert.equal(sent.template, "NTC_FNMA_C2_1_02_RATE_CHANGE"); assert.equal(sent.regz_c_notice, false); assert.equal(sent.fnma_informational, true); assert.equal(sent.late, false); assert.equal(sent.marked_as, "required_by_contract_information");
  assert.deepEqual(r.sentTemplates(LOAN), ["NTC_FNMA_C2_1_02_RATE_CHANGE"]);
  assert.match(r.notices.get(sent.notice_id!).rendered.text, /Your interest rate changes from 5\.750% to 5\.875% on November 1, 2026\. Your monthly payment of \$2,334\.29 does not change\./);
  assert.equal(r.status("REGZ_1026_20C_FREQ_ADJ_NOTICE_25"), "armed", "no (c) notice was generated, so the (c) clock is untouched");
  // sent inside 25 days the C-2.1-02 notice is held by the checklist (rule 6 policy ≥ 25 days)
  const l = rig("2026-10-05"); O.boardArmTerms(l.deps(), { ...PLAN_4927, fnma_arm_plan: null, index_type: "CMT_1Y", adjustment_period_months: 1, payment_change_period_months: 12, first_change_date: "2026-10-01", consummation_date: "2004-10-15", first_payment_due: "2004-12-01", schedule_basis: { upb_cents: 37104886n, rate_pct: "5.750", pi_cents: 233429n, from_due_date: "2026-11-01" } });
  O.captureIndex(l.deps(), { index_type: "CMT_1Y", effective_date: "2026-09-17", value: "3.10000", source: "frb_h15" }); O.calculateAdjustment(l.deps(), LOAN, D("2026-11-01")); O.verifyAdjustment(l.deps(), LOAN, D("2026-11-01"));
  l.at("2026-10-10"); await assert.rejects(() => O.sendAdjustmentNotice(l.deps(), l.notices, { loan_id: LOAN, change_date: D("2026-11-01"), recipients: [BORROWER], contact: CONTACT }), /NTC_FNMA_C2_1_02_RATE_CHANGE for L-4927 2026-11-01 is held: checklist: 25-days/);
});
test("7.2-T9: Given a 2-1 temporary buydown stepping on 2027-01-01, then `NTC_FNMA_C2_1_02_BUYDOWN_STEP_90` is sent by 2026-10-03.", async () => {
  assert.deepEqual(buydownStepNotice(D("2027-01-01")), { template: "NTC_FNMA_C2_1_02_BUYDOWN_STEP_90", send_by: "2026-10-03", timer: "FNMA_C2_1_02_BUYDOWN_STEP_NOTICE_90" });
  // the 1.1 buydown schedule scheduled on the loan arms the 90-day clock on each step date; the registry send closes it
  const STEPS = [{ step_date: "2027-01-01", current_effective_rate_pct: "3.750", new_effective_rate_pct: "4.750", note_rate_pct: "5.750", current_pi_cents: 185246n, new_pi_cents: 208659n }, { step_date: "2028-01-01", current_effective_rate_pct: "4.750", new_effective_rate_pct: "5.750", note_rate_pct: "5.750", current_pi_cents: 208659n, new_pi_cents: 233429n }];
  const r = rig("2026-06-01"); const sch = O.scheduleBuydownSteps(r.deps(), "L-BD", STEPS);
  assert.equal(sch.events.length, 2); assert.equal(sch.events[0]!.type, "buydown.step.scheduled"); assert.equal(sch.events[0]!.payload.step_date, "2027-01-01"); assert.equal(sch.events[0]!.payload.notice_send_by, "2026-10-03");
  const timers = r.engine.byCode("FNMA_C2_1_02_BUYDOWN_STEP_NOTICE_90"); assert.deepEqual(timers.map((t) => t.dueDate), ["2026-10-03", "2027-10-03"]);
  r.at("2026-10-01"); const sent = await O.sendBuydownStepNotice(r.deps(), r.notices, { loan_id: "L-BD", step_date: D("2027-01-01"), recipients: [BORROWER], contact: CONTACT });
  assert.equal(sent.template, "NTC_FNMA_C2_1_02_BUYDOWN_STEP_90"); assert.equal(sent.send_by, "2026-10-03"); assert.equal(sent.late, false); assert.equal(sent.days_before_change, 92);
  assert.equal(timers[0]!.status, "satisfied"); assert.equal(timers[1]!.status, "satisfied", "one send closes every open step clock on the loan (same pattern) — the 2028 step is re-armed by its own schedule when the loan advances");
  assert.match(r.notices.get(sent.notice_id).rendered.text, /steps up on January 1, 2027: the rate you pay changes from 3\.750% to 4\.750% \(note rate 5\.750%\) and your monthly principal and interest payment changes from \$1,852\.46 to \$2,086\.59/);
  // not sent by 2026-10-03 → sev-2 breach; a send inside 90 days is held by the checklist
  const b = rig("2026-06-01"); O.scheduleBuydownSteps(b.deps(), "L-BD", STEPS.slice(0, 1)); b.at("2026-10-04");
  const breach = b.engine.evaluate(b.clock.now()).find((x) => x.def.code === "FNMA_C2_1_02_BUYDOWN_STEP_NOTICE_90")!; assert.equal(breach.severity, 2);
  await assert.rejects(() => O.sendBuydownStepNotice(b.deps(), b.notices, { loan_id: "L-BD", step_date: D("2027-01-01"), recipients: [BORROWER], contact: CONTACT }), /is held: checklist: 90-days/);
  assert.throws(() => O.scheduleBuydownSteps(b.deps(), "L-BD2", [{ ...STEPS[0]!, new_effective_rate_pct: "6.000" }]), /exceeds the note rate/);
  assert.throws(() => O.scheduleBuydownSteps(b.deps(), "L-BD2", []), /at least one step/);
});
test("7.2-T10: Given a boarding margin error discovered (2.750 booked as 3.250) after two adjustments, then re-amortization yields the overcharge, a cash refund is issued (combined error > $1.00), the correction notice is sent, the correction is reported only after `irr_discussed_at` is set, and both are complete within 60 days.", async () => {
  const SEGMENTS = [{ correct_rate_pct: "6.375", booked_rate_pct: "6.875", months: 6, payment_cents: 259688n }, { correct_rate_pct: "6.375", booked_rate_pct: "6.875", months: 1, payment_cents: 259688n }];
  const c = marginErrorCorrection({ discovered_on: D("2027-06-10"), upb_at_first_change_cents: 37104886n, segments: SEGMENTS, current: true, advances: false, irr_discussed_at: null });
  // re-amortized from the first erroneous change (Nov 1, 2026) at 6.375% vs the booked 6.875% with the 7 actual payments of $2,596.88 (independent recomputation: interest half-up to cents each month)
  assert.equal(c.reamortized_upb_cents, 36659865n); assert.equal(c.actual_upb_cents, 36769408n); assert.equal(c.net_effect_cents, 109543n);   // $1,095.43 overcharge > $1.00
  assert.equal(c.treatment, "cash_refund"); assert.equal(c.correction_notice, "NTC_FNMA_C2_2_01_ARM_CORRECTION"); assert.equal(c.report_to_fnma, false); assert.equal(c.complete_by, "2027-08-09"); assert.equal(c.timer, "FNMA_C2_2_01_ARM_ERROR_CORRECT_60");
  assert.equal(marginErrorCorrection({ discovered_on: D("2027-06-08"), confirmed_on: D("2027-06-10"), upb_at_first_change_cents: 37104886n, segments: [{ correct_rate_pct: "6.375", booked_rate_pct: "6.875", months: 7, payment_cents: 259688n }], current: true, advances: false, irr_discussed_at: "2027-06-12T15:00:00Z" }).report_to_fnma, true);
  assert.equal(marginErrorCorrection({ discovered_on: D("2027-06-08"), confirmed_on: D("2027-06-10"), upb_at_first_change_cents: 37104886n, segments: SEGMENTS, current: true, advances: false, irr_discussed_at: null }).complete_by, "2027-08-09");   // 60 days from the confirmation date
  // the correction workflow: suspected (boarding audit) → confirmed → records corrected, borrower notified, reported only after the IRR discussion → complete within 60 days
  const r = rig("2027-06-10"); O.boardArmTerms(r.deps(), { ...PLAN_4927, margin_pct: "3.250", current_rate_pct: "6.875", current_pi_cents: 259688n, schedule_basis: { upb_cents: 36769408n, rate_pct: "6.875", pi_cents: 259688n, from_due_date: "2027-07-01" } });
  const inq = O.receiveArmInquiry(r.deps(), LOAN, { source: "boarding_audit", issue: "margin recorded at boarding as 3.250 (note: 2.750)", change_date: D("2026-11-01") });
  assert.equal(inq.event.type, "arm.error.suspected"); assert.equal(inq.event.payload.received_on, "2027-06-10"); assert.equal(r.engine.byCode("FNMA_C2_2_01_ARM_INQUIRY_INTERIM_20")[0]!.dueDate, "2027-06-30");
  const res = O.resolveArmInquiry(r.deps(), LOAN, inq.inquiry.inquiry_id, { outcome: "error_confirmed", confirmation: { first_erroneous_change_date: D("2026-11-01"), booked_margin_pct: "3.250", correct_margin_pct: "2.750" } });
  assert.deepEqual(res.events.map((e) => e.type), ["arm.correction.resolved", "arm.inquiry.responded", "arm.error.confirmed"]); assert.equal(res.within_20_days, true); assert.equal(r.status("FNMA_C2_2_01_ARM_INQUIRY_INTERIM_20"), "satisfied");
  const correct60 = r.engine.byCode("FNMA_C2_2_01_ARM_ERROR_CORRECT_60")[0]!; assert.equal(correct60.dueDate, "2027-08-09"); assert.equal(correct60.anchorDate, "2027-06-10");
  r.at("2027-06-11"); const first = await O.completeCorrection(r.deps(), r.notices, { loan_id: LOAN, correction_id: res.correction_id!, upb_at_first_change_cents: 37104886n, segments: SEGMENTS, current: true, advances: false, irr_discussed_at: null, recipients: [BORROWER], contact: CONTACT });
  assert.equal(first.net_effect_cents, 109543n); assert.equal(first.treatment, "cash_refund"); assert.equal(first.refund_cents, 109543n); assert.equal(first.remedy_event!.type, "arm.correction.refund_issued"); assert.equal(first.remedy_event!.payload.amount_cents, 109543n);
  assert.deepEqual(r.sentTemplates(LOAN), ["NTC_FNMA_C2_2_01_ARM_CORRECTION"]); assert.match(r.notices.get(first.notice_id!).rendered.text, /you were overcharged \$1,095\.43\. A refund check for \$1,095\.43 is enclosed/);
  assert.equal(first.completed, false); assert.deepEqual(first.missing, ["irr_discussed"]); assert.equal(first.report_to_fnma, false); assert.equal(first.investor_event, null); assert.equal(correct60.status, "armed");
  assert.equal(O.loadTerms(r.deps(), LOAN).margin_pct, "2.750");   // records corrected on a new loan_terms version
  r.at("2027-06-12"); const done = await O.completeCorrection(r.deps(), r.notices, { loan_id: LOAN, correction_id: res.correction_id!, upb_at_first_change_cents: 37104886n, segments: SEGMENTS, current: true, advances: false, irr_discussed_at: "2027-06-12T15:00:00Z" });
  assert.equal(done.completed, true); assert.deepEqual(done.missing, []); assert.equal(done.report_to_fnma, true); assert.equal(done.investor_event!.payload.correction, true); assert.equal(done.investor_event!.payload.event_type, "rate_payment_change");
  assert.equal(done.remedy_event, null, "the refund is issued once"); assert.equal(done.notice_id, null, "the correction notice is sent once"); assert.equal(r.sentTemplates(LOAN).length, 1);
  assert.equal(done.completed_event!.type, "arm.correction.completed"); assert.deepEqual([done.completed_event!.payload.records_corrected, done.completed_event!.payload.borrower_notified, done.completed_event!.payload.irr_discussed], [true, true, true]); assert.equal(done.within_60_days, true);
  assert.equal(correct60.status, "satisfied");
  await assert.rejects(() => O.completeCorrection(r.deps(), null, { loan_id: LOAN, correction_id: res.correction_id!, upb_at_first_change_cents: 37104886n, segments: SEGMENTS, current: true, advances: false, irr_discussed_at: "2027-06-12T15:00:00Z" }), /already complete/);
});
test("7.2-T11: Given an FDCPA 805(c) notice on file, then no `NTC_REGZ_20C_ARM_ADJ` is generated and the Fannie Mae informational notice is sent instead, with the decision record citing (c)(1)(ii)(C).", async () => {
  const r0 = fdcpaCeaseArmNotice({ fdcpa_cease_on_file: true, debt_collector: true });
  assert.equal(r0.regz_c_notice, false); assert.equal(r0.fnma_notice, "NTC_FNMA_C2_1_02_RATE_CHANGE"); assert.equal(r0.marked_as, "required_by_contract_information"); assert.equal(r0.decision_cite, "12 CFR 1026.20(c)(1)(ii)(C)");
  assert.equal(fdcpaCeaseArmNotice({ fdcpa_cease_on_file: true, debt_collector: false }).regz_c_notice, true);
  // through the cycle: a loan boarded in default (11.4) with the §805(c) cease on file gets the Fannie Mae notice marked as contract-required information; the (c) notice is never generated
  const r = rig("2026-06-01"); throughVerification(r, { ...PLAN_4927, fdcpa_cease_on_file: true, fdcpa_debt_collector: true });
  r.at("2026-09-21"); const sent = await O.sendAdjustmentNotice(r.deps(), r.notices, { loan_id: LOAN, change_date: D("2026-11-01"), recipients: [BORROWER], contact: CONTACT });
  assert.equal(sent.template, "NTC_FNMA_C2_1_02_RATE_CHANGE"); assert.equal(sent.regz_c_notice, false); assert.equal(sent.marked_as, "required_by_contract_information"); assert.equal(sent.decision_cite, "12 CFR 1026.20(c)(1)(ii)(C)"); assert.equal(sent.decision_record.cite, "12 CFR 1026.20(c)(1)(ii)(C)");
  assert.deepEqual(r.sentTemplates(LOAN), ["NTC_FNMA_C2_1_02_RATE_CHANGE"]); assert.ok(!r.sentTemplates(LOAN).includes("NTC_REGZ_20C_ARM_ADJ"));
  assert.match(r.notices.get(sent.notice_id!).rendered.text, /This notice is required by your mortgage loan documents \(Fannie Mae Servicing Guide C-2\.1-02\) and is provided for your information\./);
  // the same loan without the cease notification gets the (c) notice
  const c = rig("2026-06-01"); throughVerification(c, { ...PLAN_4927, fdcpa_cease_on_file: false, fdcpa_debt_collector: true }); c.at("2026-09-21");
  const cn = await O.sendAdjustmentNotice(c.deps(), c.notices, { loan_id: LOAN, change_date: D("2026-11-01"), recipients: [BORROWER], contact: CONTACT });
  assert.equal(cn.template, "NTC_REGZ_20C_ARM_ADJ"); assert.equal(cn.decision_cite, "12 CFR 1026.20(c)"); assert.equal(c.status("REGZ_1026_20C_ADJ_NOTICE_60"), "satisfied");
});
test("7.2-T12: Given the NY Fed API returns HTTP 5xx for 2 days, then the capture timer alerts, the fallback source is used with dual-control evidence, and the calculation proceeds on the correct index date.", () => {
  const r0 = indexCaptureFallback({ index_date: D("2026-09-17"), api_failures: [{ on: D("2026-09-17"), status: 503 }, { on: D("2026-09-18"), status: 502 }], fallback: { source: "vendor_feed", value: "3.64883", effective_date: D("2026-09-17"), evidence_ids: ["screenshot-1"], approvers: ["ops-1", "officer-2"] } });
  assert.equal(r0.alert, true); assert.equal(r0.source, "fallback"); assert.equal(r0.index_value, "3.64883"); assert.equal(r0.index_date, "2026-09-17"); assert.equal(r0.dual_control, true); assert.equal(r0.qc_flag, true);
  assert.equal(indexCaptureFallback({ index_date: D("2026-09-17"), api_failures: [{ on: D("2026-09-17"), status: 503 }], fallback: null }).alert, false);
  assert.equal(indexCaptureFallback({ index_date: D("2026-09-17"), api_failures: [{ on: D("2026-09-17"), status: 503 }, { on: D("2026-09-18"), status: 500 }], fallback: { source: "manual", value: "3.6", effective_date: D("2026-09-17"), evidence_ids: [], approvers: ["ops-1"] } }).source, null);
  // through the cycle: two failed capture days → SM_ARM_INDEX_CAPTURE_T45 breaches (sev-2 alert); the dual-control fallback is captured on the index date and the calculation closes the clock late
  const r = rig("2026-06-01"); O.boardArmTerms(r.deps(), { ...PLAN_4927 }); r.at("2026-08-03"); O.openNoticeWindow(r.deps(), LOAN, D("2026-11-01"));
  const cap = r.engine.byCode("SM_ARM_INDEX_CAPTURE_T45")[0]!; assert.equal(cap.dueDate, "2026-09-17");
  r.at("2026-09-17", "08:30"); assert.equal(O.recordIndexFeedFailure(r.deps(), { on: D("2026-09-17"), status: 503 }).alert, false);
  assert.throws(() => O.captureIndexFallback(r.deps(), { index_date: D("2026-09-17"), fallback: { source: "vendor_feed", value: "3.64883", effective_date: D("2026-09-17"), evidence_ids: ["screenshot-1"], approvers: ["ops-1", "officer-2"] } }), /has not failed on two days/);
  r.at("2026-09-18", "08:30"); const f2 = O.recordIndexFeedFailure(r.deps(), { on: D("2026-09-18"), status: 502 }); assert.equal(f2.failed_days, 2); assert.equal(f2.alert, true);
  const breach = r.engine.evaluate(r.clock.now()).find((x) => x.def.code === "SM_ARM_INDEX_CAPTURE_T45")!; assert.equal(breach.severity, 2); assert.equal(cap.status, "breached");
  assert.throws(() => O.captureIndexFallback(r.deps(), { index_date: D("2026-09-17"), fallback: { source: "manual", value: "3.64883", effective_date: D("2026-09-17"), evidence_ids: [], approvers: ["ops-1"] } }), /dual control/);
  const fb = O.captureIndexFallback(r.deps(), { index_date: D("2026-09-17"), fallback: { source: "vendor_feed", value: "3.64883", effective_date: D("2026-09-17"), evidence_ids: ["screenshot-1"], approvers: ["ops-1", "officer-2"] } });
  assert.equal(fb.capture.source, "vendor_feed"); assert.equal(fb.capture.dual_control, true); assert.equal(fb.event!.type, "arm.index.captured"); assert.equal(fb.decision.qc_flag, true);
  const calc = O.calculateAdjustment(r.deps(), LOAN, D("2026-11-01"));
  assert.equal(calc.adjustment.index_date, "2026-09-17"); assert.equal(calc.adjustment.index_value, "3.64883"); assert.equal(calc.adjustment.index_source, "vendor_feed"); assert.equal(calc.adjustment.new_rate_pct, "6.375"); assert.equal(calc.adjustment.calculation_date, "2026-09-18");
  assert.equal(cap.status, "satisfied_late");
});
test("7.2-T13: Given a Chapter 13 debtor, then `payment.change.scheduled` reaches 14.2 at least 60 days before the new payment and the 3002.1 notice is filed ≥ 21 days before.", () => {
  const r0 = ch13PaymentChange({ first_new_payment_due: D("2026-12-01"), verified_on: D("2026-09-18") });
  assert.equal(r0.emit, "payment.change.scheduled"); assert.equal(r0.emit_by, "2026-10-02"); assert.equal(r0.on_time, true); assert.equal(r0.rule_3002_1_file_by, "2026-11-10");
  assert.equal(ch13PaymentChange({ first_new_payment_due: D("2026-12-01"), verified_on: D("2026-10-05") }).on_time, false);
  // through the cycle: verification on 2026-09-18 appends `payment.change.scheduled` on the loan for 14.2 with the Rule 3002.1(b) filing date
  const r = rig("2026-06-01"); const { ver } = throughVerification(r, { ...PLAN_4927 }, SEPT_PRINTS, "2026-09-18");
  const pc = ver.payment_change_event!; assert.equal(pc.type, "payment.change.scheduled"); assert.equal(pc.payload.first_new_payment_due, "2026-12-01"); assert.equal(pc.payload.emit_by, "2026-10-02"); assert.equal(pc.payload.emitted_on, "2026-09-18"); assert.equal(pc.payload.on_time, true); assert.equal(pc.payload.rule_3002_1_file_by, "2026-11-10");
  assert.equal(pc.payload.new_pi_cents, 247644n); assert.equal(pc.payload.new_payment_cents, 247644n + 61250n); assert.equal(pc.causationId, ver.event.id);
  assert.equal(r.events.byLoan(LOAN).filter((e) => e.type === "payment.change.scheduled").length, 1);
  const late = rig("2026-06-01"); assert.equal(throughVerification(late, { ...PLAN_4927 }, SEPT_PRINTS, "2026-10-05").ver.payment_change_event!.payload.on_time, false);
});
test("7.2-T14: Given e-delivery consent for `arm_notices`, then the notice is emailed/posted within the window; given no consent, then it is mailed; SMS-only is never used.", async () => {
  const c = newConsent("A", ["arm_notices"], "v1.3", D("2026-10-02"), "portal"); if ("error" in c) throw new Error(c.error); verify(c, true, true, D("2026-10-02"));
  assert.deepEqual(armNoticeChannel({ consent: c }), { channel: "electronic", sms_only_allowed: false });
  assert.deepEqual(armNoticeChannel({ consent: null }), { channel: "mail", sms_only_allowed: false });
  const other = newConsent("B", ["periodic_statements"], "v1.3", D("2026-10-02"), "portal"); if ("error" in other) throw new Error(other.error); verify(other, true, true, D("2026-10-02"));
  assert.equal(armNoticeChannel({ consent: other }).channel, "mail");
  // through the registry: an active `arm_notices` E-SIGN consent → email link (7.4); none → first-class mail; a consent for another class → mail; never SMS
  const withConsent = newConsent("B-1", ["arm_notices"], "v1.3", D("2026-09-20"), "portal"); if ("error" in withConsent) throw new Error(withConsent.error); verify(withConsent, true, true, D("2026-09-20"));
  const e = rig("2026-06-01"); throughVerification(e); e.at("2026-09-21");
  const em = await O.sendAdjustmentNotice(e.deps(), e.notices, { loan_id: LOAN, change_date: D("2026-11-01"), recipients: [{ ...BORROWER, email: "alex@example.com", consent: withConsent }], contact: CONTACT, consent_id: "B-1:v1.3" });
  assert.equal(em.channel, "electronic"); assert.equal(e.ed.messages.size, 1); assert.equal(e.pm.jobs.size, 0); assert.equal(em.days_before_first_payment, 71); assert.equal(em.decision_record.consent_id, "B-1:v1.3");
  const channels = e.events.byLoan(LOAN).filter((x) => x.type === "notice.sent").flatMap((x) => (x.payload.channels as { channel: string }[]).map((ch) => ch.channel));
  assert.deepEqual(channels, ["email_link"]); assert.ok(channels.every((ch) => !ch.startsWith("sms")));
  const m = rig("2026-06-01"); throughVerification(m); m.at("2026-09-21");
  const ml = await O.sendAdjustmentNotice(m.deps(), m.notices, { loan_id: LOAN, change_date: D("2026-11-01"), recipients: [BORROWER], contact: CONTACT });
  assert.equal(ml.channel, "mail"); assert.equal(m.pm.jobs.size, 1); assert.equal(m.ed.messages.size, 0); assert.equal(m.status("REGZ_1026_20C_ADJ_NOTICE_60"), "satisfied");
  const o = rig("2026-06-01"); throughVerification(o); o.at("2026-09-21");
  const statementsOnly = newConsent("B-1", ["periodic_statements"], "v1.3", D("2026-09-20"), "portal"); if ("error" in statementsOnly) throw new Error(statementsOnly.error); verify(statementsOnly, true, true, D("2026-09-20"));
  assert.equal((await O.sendAdjustmentNotice(o.deps(), o.notices, { loan_id: LOAN, change_date: D("2026-11-01"), recipients: [{ ...BORROWER, email: "alex@example.com", consent: statementsOnly }], contact: CONTACT })).channel, "mail");
  assert.equal(O.parseArmTerms({ ...PLAN_4927 }).escrow_cents, 61250n);
});

test("7.2 worked example (Plan 4927): $400,000.00 at 5.750% → expected UPB $371,048.86 after 60 payments of $2,334.29; 6.375% → P&I $2,476.44 (total $3,088.94 with escrow $612.50 vs $2,946.79); a 5.100 index caps at 7.750% → $2,802.64; overcharges above $1.00 are refunded", async () => {
  assert.equal(scheduledUpbAfter(40000000n, "5.750", 233429n, 60), 37104886n);
  const base = { ...BASE, index_pct: "3.64883", expected_upb_cents: 37104886n, remaining_term_months: 300 };
  const a = computeArmAdjustment(base); const b = verifyArmAdjustment(base, a);
  assert.equal(a.new_rate_pct, "6.375"); assert.equal(a.new_pi_cents, 247644n); assert.equal(b.agrees, true); assert.equal(b.discrepancy, null);
  assert.deepEqual(armNoticeFigures({ current_pi_cents: 233429n, new_pi_cents: 247644n, escrow_cents: 61250n }), { current_total_cents: 294679n, total_payment_cents: 308894n });
  const capped = computeArmAdjustment({ ...base, index_pct: "5.10000" }); assert.equal(capped.new_rate_pct, "7.750"); assert.equal(capped.bound, "initial"); assert.equal(capped.new_pi_cents, 280264n);
  assert.equal(verifyArmAdjustment({ ...base, index_pct: "5.10000" }, capped).agrees, true);
  assert.equal(newPayment(37104886n, "7.750", 300), 280264n);
  assert.equal(marginErrorCorrection({ discovered_on: D("2027-06-10"), upb_at_first_change_cents: 37104886n, segments: [{ correct_rate_pct: "6.375", booked_rate_pct: "6.375", months: 6, payment_cents: 247644n }], current: true, advances: false, irr_discussed_at: null }).net_effect_cents, 0n);   // no error → no refund; the $1.00 (100n) threshold is in arm.correction
  // the rendered (c) notice: P&I inside the mandated table, escrow and the total as adjacent information (decision 3); window Aug 3 – Oct 2; next change May 1, 2027 with the ±1.000% subsequent cap
  const r = rig("2026-06-01"); throughVerification(r); r.at("2026-09-21");
  const sent = await O.sendAdjustmentNotice(r.deps(), r.notices, { loan_id: LOAN, change_date: D("2026-11-01"), recipients: [BORROWER], contact: CONTACT });
  const text = r.notices.get(sent.notice_id!).rendered.text;
  assert.match(text, /Current interest rate 5\.750% — new interest rate 6\.375%\. Current principal and interest payment \$2,334\.29 — new principal and interest payment \$2,476\.44, due December 1, 2026\./);
  assert.match(text, /30-day Average SOFR, published by the Federal Reserve Bank of New York \(newyorkfed\.org\), which was 3\.64883 on September 17, 2026\. Your margin of 2\.750% percentage points is added to the index/);
  assert.match(text, /expected loan balance on November 1, 2026 is \$371,048\.86 and the remaining term is 300 months/);
  assert.match(text, /with escrow of \$612\.50, your total monthly payment will be \$3,088\.94 \(currently \$2,946\.79\)\. Next scheduled rate change: May 1, 2027\./);
  assert.deepEqual(sent.decision_record.notice_window, { not_before: "2026-08-03", deadline: "2026-10-02" }); assert.equal(sent.decision_record.new_pi, 247644n); assert.equal(sent.decision_record.expected_upb, 37104886n);
  r.at("2026-11-01"); const eff = O.makeEffective(r.deps(), LOAN, D("2026-11-01"));
  assert.equal(eff.terms.current_pi_cents, 247644n); assert.equal(eff.terms.version, 2); assert.equal(eff.next!.row.change_date, "2027-05-01"); assert.equal(eff.next!.row.index_date, "2027-03-17"); assert.equal(eff.next!.row.first_new_payment_due, "2027-06-01");
  r.at("2027-03-17"); O.captureIndex(r.deps(), nyfed("2027-03-17", "3.80000"));
  const second = O.calculateAdjustment(r.deps(), LOAN, D("2027-05-01"));
  assert.deepEqual([...second.adjustment.cap_test.periodic_limit], ["5.375", "7.375"]); assert.equal(second.adjustment.new_rate_pct, "6.500"); assert.equal(second.adjustment.prior_rate_pct, "6.375"); assert.equal(second.adjustment.remaining_term_months, 294);
  assert.equal(second.adjustment.expected_upb_cents, scheduledUpbAfter(37104886n, "6.375", 247644n, 6));   // the F-1-01 expected UPB rolls forward from the effective adjustment
});

test("7.2 timers: every registry row arms on an event the process appends and closes on the event the process appends for it (TimerEngine + eventMatches)", async () => {
  const defs = new Map(loadOverriddenRegistry().unique().filter((t) => t.process === "7.2").map((t) => [t.code, t] as const));
  assert.equal(defs.size, 11);
  const r = rig("2026-06-01"); const emitted: DomainEvent[] = []; r.events.subscribe("*", (e) => { emitted.push(e); });
  // standard plan: schedule → index → calculate → verify → window → notice → effective → LAR 83 ack
  throughVerification(r); r.at("2026-09-21"); await O.sendAdjustmentNotice(r.deps(), r.notices, { loan_id: LOAN, change_date: D("2026-11-01"), recipients: [BORROWER], contact: CONTACT });
  O.ingestLar83Feedback(r.deps(), LOAN, { record: "83", status: "accepted", effective_with_payment_due: "1226" });
  r.at("2026-11-01"); O.makeEffective(r.deps(), LOAN, D("2026-11-01"));
  // frequent adjuster (25-day row), first-adjustment estimate (c_first_25), buydown, inquiry/correction, conversion
  r.at("2026-06-01"); O.boardArmTerms(r.deps(), { ...PLAN_4927, loan_id: "L-FREQ", fnma_arm_plan: null, index_type: "CMT_1Y", adjustment_period_months: 1, consummation_date: "2004-10-15", first_payment_due: "2004-12-01", schedule_basis: { upb_cents: 37104886n, rate_pct: "5.750", pi_cents: 233429n, from_due_date: "2026-11-01" } });
  O.captureIndex(r.deps(), { index_type: "CMT_1Y", effective_date: "2026-09-17", value: "3.70000", source: "frb_h15" });
  r.at("2026-09-17"); O.openNoticeWindow(r.deps(), "L-FREQ", D("2026-11-01")); O.calculateAdjustment(r.deps(), "L-FREQ", D("2026-11-01")); O.verifyAdjustment(r.deps(), "L-FREQ", D("2026-11-01"));
  r.at("2026-10-20"); const freq = await O.sendAdjustmentNotice(r.deps(), r.notices, { loan_id: "L-FREQ", change_date: D("2026-11-01"), recipients: [BORROWER], contact: CONTACT }); assert.equal(freq.template, "NTC_REGZ_20C_ARM_ADJ");
  r.at("2026-09-16"); const est = O.boardArmTerms(r.deps(), { ...PLAN_4927, loan_id: "L-EST", fnma_arm_plan: null, index_type: "CMT_1Y", adjustment_period_months: 1, consummation_date: "2026-09-15", first_payment_due: "2026-11-01", initial_disclosure_estimate: true });
  assert.equal(est.rows[0]!.notice_kind, "c_first_25"); assert.equal(r.engine.byCode("REGZ_1026_20C_FIRST_ADJ_ESTIMATE_25")[0]!.dueDate, "2026-11-06");
  r.at("2026-09-17"); O.calculateAdjustment(r.deps(), "L-EST", D("2026-11-01")); O.verifyAdjustment(r.deps(), "L-EST", D("2026-11-01"));
  r.at("2026-10-25"); const first25 = await O.sendAdjustmentNotice(r.deps(), r.notices, { loan_id: "L-EST", change_date: D("2026-11-01"), recipients: [BORROWER], contact: CONTACT }); assert.equal(first25.template, "NTC_REGZ_20C_ARM_ADJ"); assert.equal(first25.days_before_first_payment, 37);
  r.at("2026-06-01"); O.scheduleBuydownSteps(r.deps(), "L-BD", [{ step_date: "2027-01-01", current_effective_rate_pct: "3.750", new_effective_rate_pct: "4.750", note_rate_pct: "5.750", current_pi_cents: 185246n, new_pi_cents: 208659n }]);
  r.at("2026-10-01"); await O.sendBuydownStepNotice(r.deps(), r.notices, { loan_id: "L-BD", step_date: D("2027-01-01"), recipients: [BORROWER], contact: CONTACT });
  r.at("2027-06-10"); O.boardArmTerms(r.deps(), { ...PLAN_4927, loan_id: "L-ERR", margin_pct: "3.250", current_rate_pct: "6.875", current_pi_cents: 259688n, schedule_basis: { upb_cents: 36769408n, rate_pct: "6.875", pi_cents: 259688n, from_due_date: "2027-07-01" } });
  const inq = O.receiveArmInquiry(r.deps(), "L-ERR", { source: "borrower_inquiry", issue: "margin recorded at boarding" });
  r.at("2027-06-25"); await O.sendInterimResponse(r.deps(), r.notices, { loan_id: "L-ERR", inquiry_id: inq.inquiry.inquiry_id, expected_resolution_date: D("2027-07-20"), recipients: [BORROWER], contact: CONTACT });
  const confirmed = O.confirmArmError(r.deps(), "L-ERR", { first_erroneous_change_date: D("2026-11-01"), booked_margin_pct: "3.250", correct_margin_pct: "2.750", inquiry_id: inq.inquiry.inquiry_id });
  r.at("2027-07-01"); await O.completeCorrection(r.deps(), r.notices, { loan_id: "L-ERR", correction_id: confirmed.correction_id, upb_at_first_change_cents: 37104886n, segments: [{ correct_rate_pct: "6.375", booked_rate_pct: "6.875", months: 7, payment_cents: 259688n }], current: true, advances: false, irr_discussed_at: "2027-06-30T15:00:00Z", recipients: [BORROWER], contact: CONTACT });
  r.at("2026-09-21"); O.boardArmTerms(r.deps(), { ...PLAN_4927, loan_id: "L-CONV", fnma_arm_plan: null, index_type: "CMT_1Y", adjustment_period_months: 12, conversion_option: true, consummation_date: "2004-10-15", first_payment_due: "2004-12-01", first_change_date: "2027-11-01", schedule_basis: { upb_cents: 37104886n, rate_pct: "5.750", pi_cents: 233429n, from_due_date: "2026-11-01" } });
  const conv = O.electConversion(r.deps(), "L-CONV", { conversion_effective_date: D("2026-12-01"), fixed_rate_pct: "6.000" });
  assert.equal(conv.new_payment_effective_date, "2027-01-01"); assert.equal(conv.notice_send_by, "2026-12-07"); assert.equal(conv.template, "NTC_REGZ_20C_ARM_ADJ"); assert.equal(conv.cancelled_rows, 7);   // the yearly change dates 2027-11-01 … 2033-11-01 to the 2034 maturity (spec input 1: all change dates to maturity)
  assert.equal(r.engine.byCode("FNMA_F1_01_CONVERSION_NOTICE_25")[0]!.dueDate, "2026-12-07");
  r.at("2026-10-01"); const cn = await O.sendConversionNotice(r.deps(), r.notices, { loan_id: "L-CONV", recipients: [BORROWER], contact: CONTACT }); assert.equal(cn.late, false);
  assert.throws(() => O.electConversion(r.deps(), LOAN, { conversion_effective_date: D("2027-05-01"), fixed_rate_pct: "6.000" }), /no conversion option \(Fannie Mae plan 4927: standard plans 4926–4929 provide none\)/);
  // every row: armed by an event the process appended (matching its trigger pattern), closed by an event the process appended (matching its satisfied pattern)
  for (const [code, def] of defs) {
    const insts = r.engine.byCode(code); assert.ok(insts.length > 0, `${code} never armed`);
    const closed = insts.filter((i) => i.status === "satisfied" || i.status === "satisfied_late"); assert.ok(closed.length > 0, `${code} never satisfied (statuses ${insts.map((i) => i.status).join(", ")})`);
    for (const i of closed) {
      const trigger = emitted.find((e) => e.id === i.armedByEventId)!; assert.ok(eventMatches(def.triggerPattern!, trigger), `${code}: ${trigger.type} does not match ${def.triggerPattern!.raw}`); assert.equal(trigger.actor.id, "disclosures", `${code} armed by ${trigger.actor.id}`);
      const sat = emitted.find((e) => e.id === i.satisfiedByEventId)!; assert.ok(eventMatches(def.satisfiedPattern!, sat), `${code}: ${sat.type} does not match ${def.satisfiedPattern!.raw}`); assert.equal(sat.actor.id, "disclosures", `${code} satisfied by ${sat.actor.id}`);
    }
  }
  assert.equal(r.engine.byCode("REGZ_1026_20C_ADJ_NOTICE_60").filter((i) => i.loanId === "L-FREQ" || i.loanId === "L-EST").length, 0, "the −60 row never arms on 25-day loans");
  assert.equal(r.engine.byCode("REGZ_1026_20C_ADJ_NOTICE_NOT_BEFORE_120").filter((i) => i.loanId === "L-EST").length, 0, "no not-before gate on the as-soon-as-practicable row");
  const schedule = emitted.filter((e) => e.type === "arm.schedule.row_created").map((e) => ({ loan: e.loanId, kind: e.payload.notice_kind }));
  assert.deepEqual(schedule.filter((s) => s.loan === LOAN).map((s) => s.kind), ["c_60_120", "c_60_120"]);   // the next change armed at boarding and again when the first took effect
});

test("7.2 bus: computeArmAdjustment / verifyArmAdjustment on a boarded loan run from the stored terms, schedule and captures and append the 7.2 events; without a loan they stay pure engine calls", async () => {
  const clock = new FixedClock(toIso(zonedEpochMs(D("2026-09-17"), "14:00", ET))); const events = new MemoryEventStore(clock); const store = new EntityStore();
  const engine = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["7.2"] });
  const rt: ToolRuntime = { store, ports: {}, escalations: new EscalationService(events, clock), services: {} };
  const ctx: CommandContext = { loanId: LOAN, events, ledger: new MemoryLedger(), timers: engine, clock, decide: () => {}, actor: DISCLOSURES, now: clock.now() };
  const deps: O.OpsDeps = { events, store, actor: DISCLOSURES, now: clock.now() };
  O.boardArmTerms(deps, { ...PLAN_4927 }); for (const p of SEPT_PRINTS) O.captureIndex(deps, p);
  const compute = SECTION_07_TOOLS.find((t) => t.name === "computeArmAdjustment")!; const verifyTool = SECTION_07_TOOLS.find((t) => t.name === "verifyArmAdjustment")!;
  const c = (await compute.handler({ loan_id: LOAN, change_date: "2026-11-01" }, ctx, rt)) as ReturnType<typeof O.calculateAdjustment>;
  assert.equal(c.adjustment.new_rate_pct, "6.375"); assert.equal(c.adjustment.new_pi_cents, 247644n); assert.equal(c.event.type, "arm.adjustment.calculated"); assert.equal(events.byLoan(LOAN).filter((e) => e.type === "arm.adjustment.calculated").length, 1);
  assert.equal(engine.byCode("SM_ARM_INDEX_CAPTURE_T45")[0]!.status, "satisfied");
  const v = (await verifyTool.handler({ loan_id: LOAN, change_date: "2026-11-01" }, ctx, rt)) as O.VerifyResult;
  assert.equal(v.agrees, true); assert.equal(engine.byCode("SM_ARM_DUAL_CALC_VERIFY_T0")[0]!.status, "satisfied"); assert.equal(engine.byCode("FNMA_IRM_LAR83_RATE_CHANGE_BD5")[0]!.dueDate, "2026-09-24");
  const pure = (await compute.handler({ ...BASE, index_pct: "3.64883", expected_upb_cents: 37104886n, remaining_term_months: 300 }, ctx, rt)) as ReturnType<typeof computeArmAdjustment>;
  assert.equal(pure.new_pi_cents, 247644n); assert.equal(events.byLoan(LOAN).filter((e) => e.type === "arm.adjustment.calculated").length, 1, "a pure engine call appends nothing");
  await assert.rejects(async () => compute.handler({}, ctx, rt), RangeError);
  assert.throws(() => O.parseArmTerms({ ...PLAN_4927, product: "fixed" }), /product fixed is not ARM/);
  assert.throws(() => O.parseArmTerms({ ...PLAN_4927, margin_pct: undefined }), /margin_pct is required/);
  assert.equal(addDays(D("2026-12-01"), -60), "2026-10-02");
});
