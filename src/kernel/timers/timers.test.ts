import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { parseOffset } from "./offset.ts";
import { loadRegistry } from "./registry.ts";
import { TimerEngine, computeDue } from "./engine.ts";
import { MemoryEventStore, FixedClock, SYSTEM } from "../events/index.ts";
import { plainDate as D } from "../calendar/date.ts";
import { toIso, zonedEpochMs } from "../calendar/zoned.ts";

test("offset grammar covers the registry's real shapes", () => {
  assert.deepEqual(parseOffset("−14 calendar_days"), { kind: "step", n: -14, unit: "calendar_days" });
  assert.deepEqual(parseOffset("+1 business_days_servicer (close of business T-1 per F-1-11, received by T+1)"),
    { kind: "step", n: 1, unit: "business_days_servicer", note: "close of business T-1 per F-1-11, received by T+1" });
  assert.deepEqual(parseOffset("+5 business_days_fannie_et, 20:00 ET"), { kind: "step", n: 5, unit: "business_days_fannie_et", at: { hhmm: "20:00", timeZone: "America/New_York" } });
  assert.deepEqual(parseOffset("next business_days_fannie_et at 03:00 America/New_York"), { kind: "next_business_day", unit: "business_days_fannie_et", at: { hhmm: "03:00", timeZone: "America/New_York" } });
  assert.deepEqual(parseOffset("6 × months"), { kind: "step", n: 6, unit: "months" });
  assert.deepEqual(parseOffset("30 `calendar_days`"), { kind: "step", n: 30, unit: "calendar_days" });
  assert.deepEqual(parseOffset("+5 BD"), { kind: "step", n: 5, unit: "business_days_servicer" });
  assert.deepEqual(parseOffset("every 90 calendar_days (\"at a minimum, every three months\")"), { kind: "recurring", every: 90, unit: "calendar_days", note: "\"at a minimum, every three months\"" });
  assert.deepEqual(parseOffset("annual"), { kind: "recurring", every: 1, unit: "years" });
  assert.deepEqual(parseOffset("0"), { kind: "same_day" });
  assert.deepEqual(parseOffset("—"), { kind: "none" });
  assert.deepEqual(parseOffset("until `case.noe.responded`"), { kind: "until", condition: "case.noe.responded" });
  assert.equal(parseOffset("second engine result must match to the cent").kind, "prose");
  assert.equal(parseOffset("+72 hours").kind, "step");
});

test("registry loads every registry row with parsed structure", () => {
  const reg = loadRegistry();
  const rows = JSON.parse(readFileSync(fileURLToPath(new URL("../../../spec/registry/timers.json", import.meta.url)), "utf8")) as unknown[];
  assert.equal(reg.all().length, rows.length); assert.ok(rows.length >= 1365);
  const t = reg.get("SM_BOARD_PRELIM_TAPE_14")!;
  assert.equal(t.process, "1.1");
  assert.equal(t.kindNorm, "deadline");
  assert.equal(t.anchorField, "transfer_date");
  assert.equal(t.triggerPattern?.type, "transfer.batch.approved");
  assert.equal(t.satisfiedPattern?.type, "transfer.tape.received");
  assert.deepEqual(t.satisfiedPattern?.conditions, [{ field: "kind", op: "=", value: "preliminary" }]);
  assert.equal(t.severity.level, 2);
  assert.ok(t.severity.escalateTo.includes("officer"));
  assert.ok(reg.forProcess("1.1").length >= 8);
});

test("computeDue: 1.1-T7 EscrowSetup due 03:00 ET the next Fannie business day", () => {
  // Boarded Wed Dec 2, 2026 at 16:00 ET → due Thu Dec 3, 2026 03:00 ET (08:00Z)
  const anchorMs = zonedEpochMs(D("2026-12-02"), "16:00", "America/New_York");
  const due = computeDue(parseOffset("next business_days_fannie_et at 03:00 America/New_York"), D("2026-12-02"), anchorMs);
  assert.equal(due.dueDate, "2026-12-03");
  assert.equal(toIso(due.dueAt!), "2026-12-03T08:00:00.000Z");
  // Same offset anchored Wed Nov 25, 2026 → skips Thanksgiving → Fri Nov 27
  assert.equal(computeDue(parseOffset("next business_days_fannie_et at 03:00 America/New_York"), D("2026-11-25"), 0).dueDate, "2026-11-27");
  // Business-day walk across a weekend
  assert.equal(computeDue(parseOffset("+2 business_days_servicer"), D("2026-10-01"), 0).dueDate, "2026-10-05");
  assert.equal(computeDue(parseOffset("−14 calendar_days"), D("2026-10-01"), 0).dueDate, "2026-09-17");
});

test("engine arms on trigger, satisfies on event, breaches when overdue (1.1-T6 shape)", () => {
  const clock = new FixedClock("2026-09-10T15:00:00.000Z");
  const events = new MemoryEventStore(clock);
  const engine = new TimerEngine(loadRegistry(), events, { processes: ["1.1"] });

  // Batch approved Sept 10 for transfer date Oct 1, 2026 → prelim tape due Sep 17, final tape due Oct 2.
  events.append({ type: "transfer.batch.approved", aggregate: { kind: "transfer_batch", id: "B1" }, actor: SYSTEM,
    payload: { transfer_date: "2026-10-01", type: "master_to_sub" } });
  const prelim = engine.byCode("SM_BOARD_PRELIM_TAPE_14")[0]!;
  const final = engine.byCode("SM_BOARD_FINAL_TAPE_1")[0]!;
  assert.equal(prelim.status, "armed");
  assert.equal(prelim.dueDate, "2026-09-17");
  assert.equal(final.dueDate, "2026-10-02");

  // Preliminary tape arrives on time → satisfied; final tape is still open.
  clock.set("2026-09-16T12:00:00.000Z");
  events.append({ type: "transfer.tape.received", aggregate: { kind: "transfer_batch", id: "B1" }, actor: SYSTEM, payload: { kind: "preliminary" } });
  assert.equal(prelim.status, "satisfied");
  assert.equal(final.status, "armed");

  // Nothing is overdue on Oct 1; on Oct 3 the final-tape deadline has breached at sev 1 → officer.
  assert.equal(engine.evaluate("2026-10-01T12:00:00.000Z").length, 0);
  const breaches = engine.evaluate("2026-10-03T12:00:00.000Z");
  assert.equal(breaches.length, 1);
  assert.equal(breaches[0]!.def.code, "SM_BOARD_FINAL_TAPE_1");
  assert.equal(breaches[0]!.severity, 1);
  assert.ok(breaches[0]!.escalateTo.includes("officer"));
  assert.equal(final.status, "breached");

  // Late arrival is recorded as satisfied_late, and the audit trail has the timer events.
  clock.set("2026-10-03T13:00:00.000Z");
  events.append({ type: "transfer.tape.received", aggregate: { kind: "transfer_batch", id: "B1" }, actor: SYSTEM, payload: { kind: "final" } });
  assert.equal(final.status, "satisfied_late");
  const types = events.all().map((e) => e.type);
  assert.ok(types.includes("timer.armed") && types.includes("timer.satisfied") && types.includes("timer.breached"));
});

test("loan-scoped timers only satisfy on the same loan", () => {
  const clock = new FixedClock("2026-10-01T15:00:00.000Z");
  const events = new MemoryEventStore(clock);
  const engine = new TimerEngine(loadRegistry(), events, { processes: ["1.1"] });
  events.append({ type: "loan.boarded", loanId: "L1", actor: SYSTEM, payload: { min: null, mers_eligible: true, transfer_date: "2026-10-01" } });
  events.append({ type: "loan.boarded", loanId: "L2", actor: SYSTEM, payload: { min: "100012345678901238", mers_eligible: true, transfer_date: "2026-10-01" } });
  const mers = engine.byCode("MERS_PROC_REGISTER_UNREGISTERED_7");
  assert.equal(mers.length, 1);                       // only the unregistered loan arms the 7-day MERS registration timer
  assert.equal(mers[0]!.loanId, "L1");
  assert.equal(mers[0]!.dueDate, "2026-10-08");
  events.append({ type: "mers.registration.confirmed", loanId: "L2", actor: SYSTEM, payload: {} });
  assert.equal(mers[0]!.status, "armed");             // L2's confirmation does not satisfy L1's timer
  events.append({ type: "mers.registration.confirmed", loanId: "L1", actor: SYSTEM, payload: {} });
  assert.equal(mers[0]!.status, "satisfied");
});

test("offset grammar: calendar-day, window, fixed-date and evaluator shapes added for the section overrides", () => {
  assert.deepEqual(parseOffset("CD18 (preceding fannie_et BD)"), { kind: "calendar_day", day: 18, monthOffset: 0, rollBackTo: "business_days_fannie_et", note: "preceding fannie_et BD" });
  assert.deepEqual(parseOffset("18th of the following month (preceding fannie_et BD)"), { kind: "calendar_day", day: 18, monthOffset: 1, rollBackTo: "business_days_fannie_et", note: "preceding fannie_et BD" });
  assert.equal((parseOffset("20th of the month after next (preceding fannie_et BD)") as { monthOffset?: number }).monthOffset, 2);
  assert.deepEqual(parseOffset("by the 20th, 23:59 local"), { kind: "calendar_day", day: 20, monthOffset: 0, at: { hhmm: "23:59", timeZone: "servicer_local" } });
  assert.deepEqual(parseOffset("last day of that month, 23:59 servicer-local"), { kind: "calendar_day", day: -1, monthOffset: 0, at: { hhmm: "23:59", timeZone: "servicer_local" } });
  assert.deepEqual(parseOffset("first day of next month, 00:05 ET"), { kind: "calendar_day", day: 1, monthOffset: 1, at: { hhmm: "00:05", timeZone: "America/New_York" } });
  assert.deepEqual(parseOffset("last business day of month, 16:00 ET (fannie_et)"), { kind: "calendar_day", day: -1, monthOffset: 0, at: { hhmm: "16:00", timeZone: "America/New_York" }, rollBackTo: "business_days_fannie_et", note: "fannie_et" });
  assert.deepEqual(parseOffset("Jan 31 (rolled to the next federal business day)"), { kind: "calendar_day", day: 31, monthOffset: 0, month: 1, yearOffset: 0, rollTo: "business_days_federal", note: "rolled to the next federal business day" });
  assert.deepEqual(parseOffset("Oct 15 following year"), { kind: "calendar_day", day: 15, monthOffset: 0, month: 10, yearOffset: 1 });
  assert.deepEqual(parseOffset("between +30 and +35 calendar_days"), { kind: "window", open: { n: 30, unit: "calendar_days" }, close: { n: 35, unit: "calendar_days" } });
  assert.deepEqual(parseOffset("window [−15, 0] calendar_days"), { kind: "window", open: { n: -15, unit: "calendar_days" }, close: { n: 0, unit: "calendar_days" } });
  assert.deepEqual(parseOffset("opens −90 calendar_days, closes −10 calendar_days"), { kind: "window", open: { n: -90, unit: "calendar_days" }, close: { n: -10, unit: "calendar_days" } });
  assert.deepEqual(parseOffset("evaluator:2.4.routeToPayoff"), { kind: "evaluator", ref: "2.4.routeToPayoff" });
  assert.deepEqual(parseOffset("same day, 16:00 ET"), { kind: "step", n: 0, unit: "calendar_days", at: { hhmm: "16:00", timeZone: "America/New_York" } });
  assert.deepEqual(parseOffset("0 (rolled to the next servicer business day)"), { kind: "step", n: 0, unit: "calendar_days", rollTo: "business_days_servicer", note: "rolled to the next servicer business day" });
  assert.deepEqual(parseOffset("BD2 17:00 ET"), { kind: "step", n: 2, unit: "business_days_fannie_et", at: { hhmm: "17:00", timeZone: "America/New_York" } });
  assert.deepEqual(parseOffset("+36 hours"), { kind: "step", n: 36, unit: "hours" });
  assert.deepEqual((parseOffset("+44 calendar_days, 23:59 loan-local") as { at?: object }).at, { hhmm: "23:59", timeZone: "loan_local" });
});

test("computeDue: calendar-day and window offsets resolve against the anchor month and Fannie calendar", () => {
  // Period opened Oct 1, 2026 → S/S draft CD18 = Sun Oct 18 → preceding Fannie BD = Fri Oct 16
  assert.equal(computeDue(parseOffset("CD18 (preceding fannie_et BD)"), D("2026-10-01"), 0).dueDate, "2026-10-16");
  // Two draft cycles after a Sept 3 acceptance: 18th of the month after next = Wed Nov 18, 2026
  assert.equal(computeDue(parseOffset("18th of the month after next (preceding fannie_et BD)"), D("2026-09-03"), 0).dueDate, "2026-11-18");
  // Month end Oct 31, 2026 → BD2 17:00 ET = Tue Nov 3, 2026
  const bd2 = computeDue(parseOffset("BD2 17:00 ET"), D("2026-10-31"), 0);
  assert.equal(bd2.dueDate, "2026-11-03");
  assert.equal(toIso(bd2.dueAt!), "2026-11-03T22:00:00.000Z");
  // Tax year closed Dec 31, 2026 → Jan 31, 2027 is a Sunday → rolled to Mon Feb 1, 2027 (federal)
  assert.equal(computeDue(parseOffset("Jan 31 (rolled to the next federal business day)"), D("2026-12-31"), 0).dueDate, "2027-02-01");
  // Electronic 1098 furnished Jan 20, 2027 → accessible through Oct 15 of the following year
  assert.equal(computeDue(parseOffset("Oct 15 following year"), D("2027-01-20"), 0).dueDate, "2028-10-15");
  // FPI reminder window from t0 = Aug 1: opens Aug 31, due Sep 5
  const w = computeDue(parseOffset("between +30 and +35 calendar_days"), D("2026-08-01"), 0);
  assert.equal(w.opensDate, "2026-08-31");
  assert.equal(w.dueDate, "2026-09-05");
  // Last day of the due month, e.g. a repayment-plan row due Feb 10, 2028 (leap year)
  assert.equal(computeDue(parseOffset("last day of that month, 23:59 servicer-local"), D("2028-02-10"), 0).dueDate, "2028-02-29");
  // Evaluator offsets carry no clock — the domain asserts them
  assert.deepEqual(computeDue(parseOffset("evaluator:12.4.incrementMax3Months"), D("2026-10-01"), 0), { evaluator: "12.4.incrementMax3Months" });
});

test("a later override that leaves the anchor alone keeps the anchor field an earlier override set", () => {
  const reg = loadRegistry();
  const code = reg.unique().find((t) => t.anchorField === null && t.satisfiedPattern !== null)!.code;
  const first = reg.override(code, { anchorField: "sent_on", why: "test: computed anchor" });
  assert.equal(first.anchorField, "sent_on");
  const second = reg.override(code, { satisfied: "`notice.sent{template=X}`", why: "test: satisfied only" });
  assert.equal(second.anchorField, "sent_on");
  assert.equal(second.satisfiedPattern?.type, "notice.sent");
  // Re-pointing the anchor text re-parses the field; an explicit anchorField still wins.
  assert.equal(reg.override(code, { anchor: "`received_on`" }).anchorField, "received_on");
  assert.equal(reg.override(code, { anchor: "receipt", anchorField: "assumed_receipt_on" }).anchorField, "assumed_receipt_on");
});

test("satisfying a recurring timer re-arms it once for the next cycle (no re-arm loop)", () => {
  const reg = loadRegistry();
  const def = reg.unique().find((t) => t.kindNorm === "recurring" && t.offsetParsed.kind === "recurring" && t.triggerPattern && t.satisfiedPattern && t.satisfiedPattern.type !== t.triggerPattern.type)!;
  const events = new MemoryEventStore();
  const engine = new TimerEngine(reg, events, { processes: [def.process] });
  const trigger = events.append({ type: def.triggerPattern!.type, actor: SYSTEM, aggregate: { kind: "global", id: "*" }, payload: Object.fromEntries((def.triggerPattern!.conditions ?? []).map((c) => [c.field, Array.isArray(c.value) ? c.value[0] : c.value === "true" ? true : c.value])) });
  const armed = engine.byCode(def.code).filter((i) => i.status === "armed");
  assert.equal(armed.length, 1, `${def.code} arms once on ${trigger.type}`);
  events.append({ type: def.satisfiedPattern!.type, actor: SYSTEM, aggregate: { kind: "global", id: "*" }, causationId: trigger.id, payload: Object.fromEntries((def.satisfiedPattern!.conditions ?? []).map((c) => [c.field, Array.isArray(c.value) ? c.value[0] : c.value === "true" ? true : c.value])) });
  const after = engine.byCode(def.code);
  assert.deepEqual(after.map((i) => i.status).sort(), ["armed", "satisfied"], `${def.code}: one satisfied instance and exactly one re-armed instance`);
});

test("a recurring row overridden with subject: \"global\" is the day's clock, not the trigger aggregate's: armed once by the first publish, left alone by a second, satisfied by any run's receipt, re-armed for the next day (20.1 SM_REFI_TRIGGER_DAILY)", () => {
  const reg = loadRegistry();
  reg.override("SM_REFI_TRIGGER_DAILY", { anchorField: "published_on", offset: "+1 calendar_days, 06:30 ET", subject: "global", why: "test: the 20.1 override (src/domain/leads-pricing/timers-20-1.ts)" });
  assert.equal(reg.get("SM_REFI_TRIGGER_DAILY")!.subjectOverride, "global");
  const clock = new FixedClock("2026-10-01T10:35:00.000Z"); const events = new MemoryEventStore(clock);
  const engine = new TimerEngine(reg, events, { processes: ["20.1"] });
  const publish = (id: string, at: string) => events.append({ type: "rate_sheet.published", actor: SYSTEM, occurredAt: at, aggregate: { kind: "rate_sheet", id }, payload: { rate_sheet_id: id, published_on: at.slice(0, 10), origination: true } });
  const ran = (sheet: string, at: string) => events.append({ type: "refi.trigger.run_completed", actor: SYSTEM, occurredAt: at, aggregate: { kind: "rate_sheet", id: sheet }, payload: { run_id: `run-${at.slice(0, 10)}`, rate_sheet_id: sheet, origination: true } });
  publish("rs-2026-10-01", "2026-10-01T10:35:00.000Z");
  let all = engine.byCode("SM_REFI_TRIGGER_DAILY");
  assert.equal(all.length, 1); assert.deepEqual(all[0]!.subject, { kind: "global", id: "*" }); assert.equal(all[0]!.loanId, undefined); assert.equal(all[0]!.dueAt, zonedEpochMs(D("2026-10-02"), "06:30", "America/New_York"));
  publish("rs-2026-10-01-intraday", "2026-10-01T15:00:00.000Z");               // a ≥ 12.5 bps republish the same day: the day's clock is one instance
  assert.equal(engine.byCode("SM_REFI_TRIGGER_DAILY").length, 1);
  ran("rs-2026-10-01-intraday", "2026-10-01T15:10:00.000Z");                   // whichever sheet the run priced with satisfies the day's clock; recurring → re-armed for tomorrow 06:30
  all = engine.byCode("SM_REFI_TRIGGER_DAILY");
  assert.deepEqual(all.map((i) => i.status), ["satisfied", "armed"]); assert.equal(all[1]!.dueAt, zonedEpochMs(D("2026-10-02"), "06:30", "America/New_York")); assert.deepEqual(all[1]!.subject, { kind: "global", id: "*" });
  publish("rs-2026-10-02", "2026-10-02T10:30:00.000Z");                        // tomorrow's first publish finds the re-armed clock and leaves it
  assert.equal(engine.byCode("SM_REFI_TRIGGER_DAILY").length, 2);
  ran("rs-2026-10-02", "2026-10-02T10:31:00.000Z");                            // and tomorrow's run satisfies it — nothing to breach at 06:30
  all = engine.byCode("SM_REFI_TRIGGER_DAILY");
  assert.deepEqual(all.map((i) => i.status), ["satisfied", "satisfied", "armed"]);
  assert.equal(engine.evaluate("2026-10-02T10:31:00.000Z").filter((b) => b.instance.code === "SM_REFI_TRIGGER_DAILY").length, 0);
  // without the override the same events leave the first sheet's re-armed clock unsatisfiable (the row 20.1 cites; the reason for the knob)
  const plain = loadRegistry(); plain.override("SM_REFI_TRIGGER_DAILY", { anchorField: "published_on", offset: "+1 calendar_days, 06:30 ET" });
  const e2 = new MemoryEventStore(clock); const eng2 = new TimerEngine(plain, e2, { processes: ["20.1"] });
  e2.append({ type: "rate_sheet.published", actor: SYSTEM, occurredAt: "2026-10-01T10:35:00.000Z", aggregate: { kind: "rate_sheet", id: "rs-a" }, payload: { rate_sheet_id: "rs-a", published_on: "2026-10-01", origination: true } });
  e2.append({ type: "refi.trigger.run_completed", actor: SYSTEM, occurredAt: "2026-10-01T10:41:00.000Z", aggregate: { kind: "rate_sheet", id: "rs-a" }, payload: { origination: true } });
  e2.append({ type: "refi.trigger.run_completed", actor: SYSTEM, occurredAt: "2026-10-02T10:41:00.000Z", aggregate: { kind: "rate_sheet", id: "rs-b" }, payload: { origination: true } });
  assert.deepEqual(eng2.byCode("SM_REFI_TRIGGER_DAILY").map((i) => [i.subject.id, i.status]), [["rs-a", "satisfied"], ["rs-a", "armed"]], "the per-sheet subject: yesterday's re-armed clock never meets today's run");
});
