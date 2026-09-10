/**
 * Typed view over spec/registry/timers.json. Every row keeps its verbatim
 * source columns and gains parsed `offset`, `triggerPattern` and
 * `satisfiedPattern` plus a normalized `kind`. Rows whose columns are prose
 * are still loaded — they just carry `prose` markers so the engine escalates
 * them to a human queue instead of guessing.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseOffset, type ParsedOffset } from "./offset.ts";
import { parseEventPattern, type EventPattern } from "../events/match.ts";

export interface RawTimer {
  readonly code: string; readonly section: number; readonly process: string; readonly kind: string;
  readonly trigger: string; readonly anchor: string; readonly offset: string; readonly satisfied: string; readonly breach: string;
}

export type TimerKind = "deadline" | "not_before_gate" | "recurring" | "gate" | "validation" | "rule" | "informational" | "retention" | "other";

export interface Severity { readonly level: 1 | 2 | 3 | 4 | null; readonly escalateTo: readonly string[]; }

export interface TimerDef extends RawTimer {
  readonly kindNorm: TimerKind;
  readonly kindQualifier?: string;
  readonly offsetParsed: ParsedOffset;
  readonly triggerPattern: EventPattern | null;
  readonly satisfiedPattern: EventPattern | null;
  readonly anchorField: string | null;
  readonly severity: Severity;
  /** Timer codes this row says it cross-references / is owned by (e.g. "(11.1)", "owned by 5.1"). */
  readonly ownedBy?: string;
}

const KIND_MAP: [RegExp, TimerKind][] = [
  [/^not[_ ]before/i, "not_before_gate"], [/^not[_ ]after|must-(act|stop)-(before|by)/i, "not_before_gate"],
  [/^recurring|recurring/i, "recurring"], [/^deadline|deadline/i, "deadline"],
  [/^gate|\bgate\b/i, "gate"], [/^validation/i, "validation"], [/^rule|policy/i, "rule"],
  [/^informational|^expectation|^target/i, "informational"], [/^retention/i, "retention"],
  [/^monitor|^warning|^computed|^hold/i, "informational"],
];

function normKind(kind: string): { kindNorm: TimerKind; kindQualifier?: string; ownedBy?: string } {
  const k = kind.trim();
  const owned = /(?:owned by|defined (?:in|by)|from|as in|see|as)\s+\*{0,2}(\d+\.\d+|\d+\.x|Section \d+)/i.exec(k) ?? /^\((\d+\.\d+|\d+\.x)(?:\s+owns)?\)$/.exec(k);
  const qual = /\(([^)]*)\)/.exec(k)?.[1];
  let kindNorm: TimerKind = "other";
  for (const [re, kn] of KIND_MAP) if (re.test(k)) { kindNorm = kn; break; }
  if (kindNorm === "other" && owned) kindNorm = "deadline";   // "(11.1)" rows are cross-referenced deadlines
  return { kindNorm, ...(qual ? { kindQualifier: qual } : {}), ...(owned ? { ownedBy: owned[1]! } : {}) };
}

function parseSeverity(breach: string): Severity {
  const sev = /sev(?:erity)?\s*[-: ]?\s*([1-4])/i.exec(breach);
  const roles = new Set<string>();
  for (const m of breach.matchAll(/`([a-z_\-]+)`/g)) {
    const r = m[1]!;
    if (/officer|agent|operator|counsel|analyst|human|owner|controller|compliance|manager|ops|treasury|qc|officer/.test(r)) roles.add(r);
  }
  return { level: sev ? (Number(sev[1]) as 1 | 2 | 3 | 4) : null, escalateTo: [...roles] };
}

function parseAnchor(anchor: string): string | null {
  const m = /`([a-zA-Z_][a-zA-Z0-9_.]*)`/.exec(anchor);
  if (m) return m[1]!;
  const bare = /^([a-z_][a-z0-9_]*)$/.exec(anchor.trim());
  return bare ? bare[1]! : null;
}

function firstPattern(s: string): EventPattern | null {
  // Columns often list alternatives with " / " or " or " — take the first parseable backticked expression.
  for (const m of s.matchAll(/`([^`]+)`/g)) { const p = parseEventPattern(m[1]!); if (p) return p; }
  return parseEventPattern(s.trim());
}

export function toTimerDef(raw: RawTimer): TimerDef {
  return {
    ...raw,
    ...normKind(raw.kind),
    offsetParsed: parseOffset(raw.offset),
    triggerPattern: firstPattern(raw.trigger),
    satisfiedPattern: firstPattern(raw.satisfied),
    anchorField: parseAnchor(raw.anchor),
    severity: parseSeverity(raw.breach),
  };
}

export class TimerRegistry {
  private readonly byCode = new Map<string, TimerDef>();
  private readonly list: TimerDef[] = [];
  constructor(rows: readonly RawTimer[]) {
    for (const r of rows) {
      const def = toTimerDef(r);
      // Cross-reference rows repeat a code owned elsewhere; keep the first (owning) definition.
      if (!this.byCode.has(def.code)) this.byCode.set(def.code, def);
      this.list.push(def);
    }
  }
  get(code: string): TimerDef | undefined { return this.byCode.get(code); }
  all(): readonly TimerDef[] { return this.list; }
  unique(): readonly TimerDef[] { return [...this.byCode.values()]; }
  forProcess(id: string): readonly TimerDef[] { return this.list.filter((t) => t.process === id); }
  /** Timers whose trigger pattern matches an event type (fast path by literal type). */
  triggeredBy(eventType: string): readonly TimerDef[] {
    return this.unique().filter((t) => t.triggerPattern && (t.triggerPattern.type === eventType || (t.triggerPattern.type.endsWith("*") && eventType.startsWith(t.triggerPattern.type.slice(0, -1)))));
  }
}

let cached: TimerRegistry | undefined;
export function loadRegistry(path?: string): TimerRegistry {
  if (cached && !path) return cached;
  const file = path ?? fileURLToPath(new URL("../../../spec/registry/timers.json", import.meta.url));
  const rows = JSON.parse(readFileSync(file, "utf8")) as RawTimer[];
  const reg = new TimerRegistry(rows);
  if (!path) cached = reg;
  return reg;
}
