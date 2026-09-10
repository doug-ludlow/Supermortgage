/**
 * Registry lint: how much of spec/registry/timers.json the engine can execute
 * mechanically, and which rows still need a human-authored override.
 *   node --experimental-strip-types tools/lint-registry.ts [--verbose] [--json]
 * --json prints one row per unique code after the section overrides, for tools/audit.py:
 *   armable     = the engine can arm it (non-prose offset + dotted event trigger)
 *   satisfiable = it can also be satisfied (dotted satisfied-event pattern, or an evaluator-backed gate)
 */
import { loadRegistry } from "../src/kernel/timers/registry.ts";
import { applyAllTimerOverrides } from "../src/domain/timer-overrides.ts";

const reg = loadRegistry();
const rows = reg.all();
const withOverrides = applyAllTimerOverrides(loadRegistry());
const verbose = process.argv.includes("--verbose");
const asJson = process.argv.includes("--json");
const count = (f: (t: (typeof rows)[number]) => boolean) => rows.filter(f).length;

const uniq = withOverrides.unique();
const isArmable = (t: (typeof rows)[number]) => t.offsetParsed.kind !== "prose" && t.triggerPattern !== null && t.triggerPattern.type.includes(".");
const isSatisfiable = (t: (typeof rows)[number]) => t.offsetParsed.kind === "evaluator" || (t.satisfiedPattern !== null && t.satisfiedPattern.type.includes("."));
const armable = uniq.filter(isArmable);

if (asJson) {
  const out = uniq.map((t) => ({ code: t.code, process: t.process, armable: isArmable(t), satisfiable: isSatisfiable(t) }));
  process.stdout.write(JSON.stringify(out) + "\n");
} else {
  const offsetKinds = new Map<string, number>();
  for (const t of rows) offsetKinds.set(t.offsetParsed.kind, (offsetKinds.get(t.offsetParsed.kind) ?? 0) + 1);
  const kindNorm = new Map<string, number>();
  for (const t of rows) kindNorm.set(t.kindNorm, (kindNorm.get(t.kindNorm) ?? 0) + 1);

  console.log(`rows: ${rows.length}  unique codes: ${reg.unique().length}`);
  console.log(`offset parse:`, Object.fromEntries([...offsetKinds].sort((a, b) => b[1] - a[1])));
  console.log(`kind:`, Object.fromEntries([...kindNorm].sort((a, b) => b[1] - a[1])));
  console.log(`trigger pattern parsed: ${count((t) => t.triggerPattern !== null)}/${rows.length}`);
  console.log(`satisfied pattern parsed: ${count((t) => t.satisfiedPattern !== null)}/${rows.length}`);
  console.log(`anchor field resolved: ${count((t) => t.anchorField !== null)}/${rows.length}`);
  console.log(`severity parsed: ${count((t) => t.severity.level !== null)}/${rows.length}`);
  const executable = count((t) => t.offsetParsed.kind !== "prose" && t.triggerPattern !== null);
  console.log(`mechanically armable (offset + trigger parse): ${executable}/${rows.length} (${(100 * executable / rows.length).toFixed(1)}%)`);

  // After the section overrides (src/domain/*/timers.ts) every unique code must be armable with a dotted event trigger.
  const evaluators = uniq.filter((t) => t.offsetParsed.kind === "evaluator").length;
  const overridden = uniq.filter((t) => t.overrideWhy).length;
  console.log(`after section overrides: ${armable.length}/${uniq.length} unique codes armable (${overridden} overridden, ${evaluators} evaluator-backed)`);
  console.log(`satisfiable after overrides: ${uniq.filter(isSatisfiable).length}/${uniq.length} unique codes`);

  if (verbose) {
    console.log("\n--- prose offsets ---");
    for (const t of rows) if (t.offsetParsed.kind === "prose") console.log(`${t.code.padEnd(48)} ${t.process.padEnd(5)} ${t.offset}`);
    console.log("\n--- unparsed triggers ---");
    for (const t of rows) if (!t.triggerPattern) console.log(`${t.code.padEnd(48)} ${t.process.padEnd(5)} ${t.trigger}`);
    console.log("\n--- still unarmable after overrides ---");
    for (const t of uniq) if (!armable.includes(t)) console.log(`${t.code.padEnd(48)} ${t.process.padEnd(5)} offset=${t.offset} | trigger=${t.trigger}`);
    console.log("\n--- not satisfiable after overrides ---");
    for (const t of uniq) if (!isSatisfiable(t)) console.log(`${t.code.padEnd(48)} ${t.process.padEnd(5)} satisfied=${t.satisfied}`);
  }
}
