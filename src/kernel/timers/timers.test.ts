import { test } from "node:test";
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

test("registry loads all 1,365 rows with parsed structure", () => {
  const reg = loadRegistry();
  assert.equal(reg.all().length, 1365);
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
