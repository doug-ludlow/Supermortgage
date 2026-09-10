/**
 * Every registry row must be executable after the section overrides are
 * applied: an offset the grammar parses (or an evaluator the domain asserts)
 * and a dotted event-pattern trigger. CLAUDE.md: rows the grammar can't parse
 * are handled by a cited override in the section's timers.ts, never by a
 * hard-coded deadline in service code.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadRegistry } from "../kernel/timers/registry.ts";
import { applyAllTimerOverrides, loadOverriddenRegistry, SECTION_OVERRIDES } from "./timer-overrides.ts";

const processes = new Set((JSON.parse(readFileSync(fileURLToPath(new URL("../../spec/registry/processes.json", import.meta.url)), "utf8")) as { id: string }[]).map((p) => p.id));

test("every unique timer code is mechanically armable after section overrides", () => {
  const reg = loadOverriddenRegistry();
  const u = reg.unique();
  assert.equal(u.length, 1206);
  const prose = u.filter((t) => t.offsetParsed.kind === "prose").map((t) => `${t.code}: ${t.offset}`);
  assert.deepEqual(prose, [], "offsets still prose");
  const noTrigger = u.filter((t) => t.triggerPattern === null).map((t) => `${t.code}: ${t.trigger}`);
  assert.deepEqual(noTrigger, [], "triggers still unparsed");
  // A trigger is an event pattern over a dotted `family.event` type — bare tokens copied from prose ("same", "schedule", "FYE") are not events.
  const pseudo = u.filter((t) => !t.triggerPattern!.type.includes(".")).map((t) => `${t.code}: ${t.trigger}`);
  assert.deepEqual(pseudo, [], "pseudo-triggers");
});

test("overrides are cited and evaluator refs name a real process", () => {
  const base = loadRegistry();
  const before = new Map(base.unique().map((t) => [t.code, t]));
  const reg = applyAllTimerOverrides(base);
  let overridden = 0;
  for (const t of reg.unique()) {
    if (t === before.get(t.code)) continue;
    overridden++;
    assert.ok(t.overrideWhy && t.overrideWhy.length > 20, `${t.code} override lacks a citation`);
    if (t.offsetParsed.kind === "evaluator") {
      const m = /^(\d+\.\d+)\.[A-Za-z][A-Za-z0-9_]+$/.exec(t.offsetParsed.ref);
      assert.ok(m, `${t.code} evaluator ref malformed: ${t.offsetParsed.ref}`);
      assert.ok(processes.has(m![1]!), `${t.code} evaluator names unknown process ${m![1]}`);
    }
  }
  assert.ok(overridden >= 600, `expected the section files to override the ~620 prose rows, got ${overridden}`);
  assert.equal(SECTION_OVERRIDES.length, 19);
});

test("overrides never touch the registry file: a fresh load is still the spec's verbatim rows", () => {
  const fresh = loadRegistry();
  assert.equal(fresh.get("SM_CURTAILMENT_PAYOFF_ROUTE_GATE")!.offsetParsed.kind, "prose");
  assert.equal(loadOverriddenRegistry().get("SM_CURTAILMENT_PAYOFF_ROUTE_GATE")!.offsetParsed.kind, "evaluator");
});
