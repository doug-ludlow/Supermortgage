/**
 * Emission lint: a timer is only really satisfiable if some code path emits the
 * event its `satisfied` pattern names (and arms only if something emits its trigger).
 * lint-registry.ts checks that the patterns parse; this checks that the event type
 * string — and every field the pattern conditions on — appears in at least one
 * non-test source file other than the timer override files themselves.
 *   node --experimental-strip-types tools/lint-emission.ts [--json | --by-process | <process-id>]
 * Heuristic: a string-literal mention is taken as an emitter. Event types built from
 * template strings are invisible to it, so a listed row is a lead, not a verdict.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadRegistry, type TimerDef } from "../src/kernel/timers/registry.ts";
import { applyAllTimerOverrides } from "../src/domain/timer-overrides.ts";

const ROOT = new URL("../src", import.meta.url).pathname;
const isOverrideFile = (f: string) => /\/timers(-\d+-\d+)?\.ts$/.test(f) || /\/timer-overrides\.ts$/.test(f);
const files: string[] = [];
(function walk(d: string) {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts") && !isOverrideFile(p)) files.push(p);
  }
})(ROOT);
const corpus = new Map(files.map((f) => [f, readFileSync(f, "utf8")] as const));
const mentions = new Map<string, Set<string>>();
for (const [f, txt] of corpus) for (const m of txt.matchAll(/["'`]([a-z][a-z0-9_]*(?:\.[a-z0-9_*]+)+)["'`]/g)) {
  const s = m[1]!;
  if (!mentions.has(s)) mentions.set(s, new Set());
  mentions.get(s)!.add(f);
}
const emitters = (type: string | null): string[] => {
  if (!type) return [];
  if (type.endsWith("*")) { const pre = type.slice(0, -1); return [...new Set([...mentions].filter(([s]) => s.startsWith(pre)).flatMap(([, fs]) => [...fs]))]; }
  return [...(mentions.get(type) ?? [])];
};
const fieldsPresent = (fields: readonly string[], inFiles: readonly string[]): string[] =>
  fields.filter((fld) => !inFiles.some((f) => new RegExp(`\\b${fld.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(corpus.get(f) ?? "")));

export interface EmissionRow {
  code: string; process: string;
  trigger: string | null; trigger_emitters: number; trigger_missing_fields: string[];
  satisfied: string | null; satisfied_emitters: number; satisfied_missing_fields: string[];
  evaluator: boolean;
  /** trigger event is emitted somewhere with every conditioned field present. */
  triggered: boolean;
  /** satisfied event is emitted somewhere with every conditioned field present (or the row is evaluator-backed). */
  emitted: boolean;
}
export function lintEmission(uniq: readonly TimerDef[]): EmissionRow[] {
  return uniq.map((t) => {
    const evaluator = t.offsetParsed.kind === "evaluator";
    const trig = t.triggerPattern?.type ?? null, sat = t.satisfiedPattern?.type ?? null;
    const satFiles = emitters(sat), trigFiles = emitters(trig);
    const missing = evaluator || !satFiles.length ? [] : fieldsPresent((t.satisfiedPattern?.conditions ?? []).map((c) => c.field), satFiles);
    const trigMissing = !trigFiles.length ? [] : fieldsPresent((t.triggerPattern?.conditions ?? []).map((c) => c.field), trigFiles);
    return { code: t.code, process: t.process, trigger: trig, trigger_emitters: trigFiles.length, trigger_missing_fields: trigMissing, satisfied: sat, satisfied_emitters: satFiles.length,
      satisfied_missing_fields: missing, evaluator, emitted: evaluator || (satFiles.length > 0 && missing.length === 0), triggered: trigFiles.length > 0 && trigMissing.length === 0 };
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = lintEmission(applyAllTimerOverrides(loadRegistry()).unique());
  const arg = process.argv[2];
  const bad = rows.filter((r) => !r.emitted);
  const noTrig = rows.filter((r) => !r.triggered);
  if (arg === "--json") process.stdout.write(JSON.stringify(rows) + "\n");
  else {
    console.log(`unique timers ${rows.length}: satisfied event never emitted (or conditioned field absent) ${bad.length}; trigger never emitted ${noTrig.length}`);
    if (arg === "--by-process") {
      const by = new Map<string, { n: number; bad: number; noTrig: number }>();
      for (const r of rows) { const p = by.get(r.process) ?? { n: 0, bad: 0, noTrig: 0 }; p.n++; if (!r.emitted) p.bad++; if (!r.triggered) p.noTrig++; by.set(r.process, p); }
      for (const [p, v] of [...by].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))) if (v.bad || v.noTrig) console.log(`${p.padEnd(5)} timers=${v.n} unsatisfiable=${v.bad} untriggerable=${v.noTrig}`);
    } else if (arg) {
      for (const r of rows) if (r.process === arg && (!r.emitted || !r.triggered))
        console.log(`${r.code.padEnd(48)} trig=${r.trigger}(${r.trigger_emitters}${r.trigger_missing_fields.length ? "; fields absent: " + r.trigger_missing_fields.join(",") : ""}) sat=${r.satisfied}(${r.satisfied_emitters}${r.satisfied_missing_fields.length ? "; fields absent: " + r.satisfied_missing_fields.join(",") : ""})`);
    }
  }
}
