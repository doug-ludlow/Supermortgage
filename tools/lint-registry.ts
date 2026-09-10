/**
 * Registry lint: how much of spec/registry/timers.json the engine can execute
 * mechanically, and which rows still need a human-authored override.
 *   node --experimental-strip-types tools/lint-registry.ts [--verbose]
 */
import { loadRegistry } from "../src/kernel/timers/registry.ts";

const reg = loadRegistry();
const rows = reg.all();
const verbose = process.argv.includes("--verbose");
const count = (f: (t: (typeof rows)[number]) => boolean) => rows.filter(f).length;

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

if (verbose) {
  console.log("\n--- prose offsets ---");
  for (const t of rows) if (t.offsetParsed.kind === "prose") console.log(`${t.code.padEnd(48)} ${t.process.padEnd(5)} ${t.offset}`);
  console.log("\n--- unparsed triggers ---");
  for (const t of rows) if (!t.triggerPattern) console.log(`${t.code.padEnd(48)} ${t.process.padEnd(5)} ${t.trigger}`);
}
