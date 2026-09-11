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
  /** Section override provenance (registry.override). */
  readonly overrideWhy?: string;
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
  // Backticked tokens without dots/braces are role or agent names (`officer`, `investor-reporting`, `fnma_portal_operator`).
  for (const m of breach.matchAll(/`([a-z][a-z0-9_\-]*)`/g)) roles.add(m[1]!);
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

export type TimerOverride = Partial<Pick<TimerDef, "trigger" | "satisfied" | "anchor" | "offset" | "anchorField">> & {
  /** Name a domain evaluator for a condition-shaped gate/rule ("13.1.gate120"); sets the offset to `evaluator:<ref>`. */
  readonly evaluator?: string;
  /** Spec citation / prose the override encodes — kept on the def for the audit. */
  readonly why?: string;
};

export class TimerRegistry {
  private readonly byCode = new Map<string, TimerDef>();
  private readonly list: TimerDef[] = [];
  constructor(rows: readonly RawTimer[]) {
    for (const r of rows) this.list.push(toTimerDef(r));
    // A code can appear in several process specs (cross-references). The owning
    // definition is the one that is not marked "owned by"/"(x.y)" and has an
    // executable offset; fall back to the first non-cross-reference, then the first row.
    const groups = new Map<string, TimerDef[]>();
    for (const d of this.list) { let g = groups.get(d.code); if (!g) { g = []; groups.set(d.code, g); } g.push(d); }
    for (const [code, g] of groups) {
      // One code, one definition across origination and servicing (addendum §4: "reuse the servicing code — never
      // redefine"): a code the servicing spec (sections 1–19) names is owned there; origination rows (20–31) that
      // restate it are references. Within a side the servicing spec's own convention applies (above).
      const servicing = g.filter((d) => Number(d.process.split(".")[0]) < 20);
      const side = servicing.length ? servicing : g;
      // a row with no trigger and no offset is a bare reference ("| `CODE` | (26.4 owns) | — | — | — |"), never the definition
      const defined = side.filter((d) => d.trigger.trim() !== "" && d.trigger.trim() !== "—");
      const own = defined.length ? defined : side;
      const owning = own.find((d) => !d.ownedBy && d.offsetParsed.kind !== "prose") ?? own.find((d) => !d.ownedBy) ?? own[0]!;
      this.byCode.set(code, owning);
    }
  }
  /**
   * Section code may tighten a registry row where the spec's prose carries a
   * condition the column grammar cannot (e.g. "(escrowed loans)"), or where
   * the anchor is a computed field. Overrides are explicit and reviewable.
   */
  override(code: string, o: TimerOverride): TimerDef {
    const cur = this.byCode.get(code);
    if (!cur) throw new RangeError(`no timer ${code}`);
    const offset = o.evaluator !== undefined ? `evaluator:${o.evaluator}` : o.offset;
    const merged = toTimerDef({ ...cur, ...(o.trigger !== undefined ? { trigger: o.trigger } : {}), ...(o.satisfied !== undefined ? { satisfied: o.satisfied } : {}),
      ...(o.anchor !== undefined ? { anchor: o.anchor } : {}), ...(offset !== undefined ? { offset } : {}) });
    // A later override that touches neither `anchor` nor `anchorField` keeps the anchor field an
    // earlier override set (toTimerDef would otherwise re-parse it from the raw anchor text).
    const anchorField = o.anchorField !== undefined ? o.anchorField : o.anchor === undefined ? cur.anchorField : merged.anchorField;
    const next: TimerDef = { ...merged, anchorField, ...(o.why !== undefined ? { overrideWhy: o.why } : {}) };
    this.byCode.set(code, next);
    return next;
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

let cachedRows: RawTimer[] | undefined;
/** Load spec/registry/timers.json. Each call returns a fresh registry so per-section overrides never leak. */
export function loadRegistry(path?: string): TimerRegistry {
  if (path) return new TimerRegistry(JSON.parse(readFileSync(path, "utf8")) as RawTimer[]);
  if (!cachedRows) cachedRows = JSON.parse(readFileSync(fileURLToPath(new URL("../../../spec/registry/timers.json", import.meta.url)), "utf8")) as RawTimer[];
  return new TimerRegistry(cachedRows);
}
