import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEventPattern, eventMatches } from "./match.ts";
import { MemoryEventStore, FixedClock } from "./store.ts";
import { SYSTEM } from "./types.ts";

const ev = (type: string, payload: Record<string, unknown>) =>
  ({ id: "x", type, occurredAt: "2026-01-01T00:00:00Z", actor: SYSTEM, payload, sequence: 1 });

test("event patterns from the spec parse and match", () => {
  const p1 = parseEventPattern("`loan.boarded{min is null, mers_eligible=true}`")!;
  assert.equal(p1.type, "loan.boarded");
  assert.equal(p1.conditions.length, 2);
  assert.ok(eventMatches(p1, ev("loan.boarded", { min: null, mers_eligible: true })));
  assert.ok(!eventMatches(p1, ev("loan.boarded", { min: "1000123", mers_eligible: true })));

  const p2 = parseEventPattern("`transfer.tape.received{kind=final}`")!;
  assert.ok(eventMatches(p2, ev("transfer.tape.received", { kind: "final" })));
  assert.ok(!eventMatches(p2, ev("transfer.tape.received", { kind: "preliminary" })));

  const p3 = parseEventPattern("loan.boarded{regx_days_delinquent>0}")!;
  assert.ok(eventMatches(p3, ev("loan.boarded", { regx_days_delinquent: 61 })));
  assert.ok(!eventMatches(p3, ev("loan.boarded", { regx_days_delinquent: 0 })));

  const p4 = parseEventPattern("payment.*")!;
  assert.ok(eventMatches(p4, ev("payment.posted", {})));
  assert.ok(!eventMatches(p4, ev("loan.boarded", {})));

  const p5 = parseEventPattern("loan.boarded{remittance_type in {S/A, S/S}}")!;
  assert.ok(eventMatches(p5, ev("loan.boarded", { remittance_type: "S/S" })));
  assert.ok(!eventMatches(p5, ev("loan.boarded", { remittance_type: "A/A" })));
});

test("store appends with monotonic sequence and dispatches to subscribers", () => {
  const clock = new FixedClock("2026-10-01T12:00:00.000Z");
  const store = new MemoryEventStore(clock);
  const seen: string[] = [];
  store.subscribe("loan.boarded{escrowed=true}", (e) => { seen.push(e.loanId!); });
  store.append({ type: "loan.boarded", loanId: "L1", actor: SYSTEM, payload: { escrowed: true } });
  store.append({ type: "loan.boarded", loanId: "L2", actor: SYSTEM, payload: { escrowed: false } });
  assert.deepEqual(seen, ["L1"]);
  assert.equal(store.all().length, 2);
  assert.equal(store.all()[1]!.sequence, 2);
  assert.equal(store.all()[0]!.occurredAt, "2026-10-01T12:00:00.000Z");
});
