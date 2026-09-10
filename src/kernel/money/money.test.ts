import { test } from "node:test";
import assert from "node:assert/strict";
import { Decimal, divRound } from "./decimal.ts";
import { cents, formatCents, monthlyInterest, levelPayment, ratePercent, allocateProportional, absDiff } from "./cents.ts";

test("divRound HALF_UP rounds half away from zero", () => {
  assert.equal(divRound(5n, 2n), 3n);
  assert.equal(divRound(-5n, 2n), -3n);
  assert.equal(divRound(7n, 2n, "HALF_EVEN"), 4n);
  assert.equal(divRound(5n, 2n, "HALF_EVEN"), 2n);
  assert.equal(divRound(-7n, 2n, "FLOOR"), -4n);
  assert.equal(divRound(-7n, 2n, "CEIL"), -3n);
});

test("Decimal parse/print round-trips and arithmetic is exact", () => {
  assert.equal(Decimal.parse("6.375").toString(), "6.375");
  assert.equal(Decimal.parse("-0.05").add(Decimal.parse("0.05")).toString(), "0");
  assert.equal(Decimal.parse("1.1").mul(Decimal.parse("1.1")).toString(), "1.21");
  assert.equal(Decimal.parse("2").pow(10).toString(), "1024");
  assert.equal(Decimal.parse("1.5").toFixed(0), "2");
  assert.equal(Decimal.parse("2.5").toFixed(0, "HALF_EVEN"), "2");
});

test("cents() parses strings exactly and rejects float drift", () => {
  assert.equal(cents("245,634.12"), 24563412n);
  assert.equal(cents("-0.5"), -50n);
  assert.equal(cents(1616.03), 161603n);
  assert.throws(() => cents("1.234"));
  assert.equal(formatCents(24563412n), "$245,634.12");
  assert.equal(formatCents(-5n), "-$0.05");
});

// Spec 1.1 worked example: UPB $245,634.12 at 6.375% → $1,304.93 monthly interest.
test("monthlyInterest matches the 1.1 worked example", () => {
  assert.equal(monthlyInterest(cents("245634.12"), ratePercent("6.375")), 130493n);
});

test("levelPayment amortizes correctly", () => {
  // $200,000 at 6% for 360 months → $1,199.10 (standard textbook figure).
  assert.equal(levelPayment(cents("200000"), ratePercent("6"), 360), 119910n);
  // Zero-rate loan is straight-line.
  assert.equal(levelPayment(cents("1200"), ratePercent("0"), 12), 10000n);
  // $250,000 at 6.375% for 360 months → $1,559.67 (verified against Python decimal at prec 40).
  assert.equal(levelPayment(cents("250000"), ratePercent("6.375"), 360), 155967n);
});

test("allocateProportional never loses a cent", () => {
  const parts = allocateProportional(100n, [1n, 1n, 1n]);
  assert.deepEqual(parts, [34n, 33n, 33n]);
  assert.equal(parts.reduce((a, b) => a + b, 0n), 100n);
  assert.deepEqual(allocateProportional(-100n, [1n, 1n, 1n]).reduce((a, b) => a + b, 0n), -100n);
});
