/**
 * The spec writes trigger expressions like
 *   `loan.boarded{min is null, mers_eligible=true}`
 *   `transfer.tape.received{kind=final}`
 *   `loan.boarded{regx_days_delinquent>0}`
 * This parses them into a predicate over `DomainEvent`s.
 */
import type { DomainEvent } from "./types.ts";

export type Op = "=" | "!=" | ">" | ">=" | "<" | "<=" | "is null" | "is not null" | "in" | "truthy";
export interface Condition { readonly field: string; readonly op: Op; readonly value?: string | readonly string[]; }
export interface EventPattern { readonly type: string; readonly conditions: readonly Condition[]; readonly raw: string; }

const PATTERN = /^\s*`?([a-zA-Z0-9_.\-*]+)\s*(?:\{(.*)\})?`?\s*$/;

export function parseEventPattern(raw: string): EventPattern | null {
  const m = PATTERN.exec(raw);
  if (!m) return null;
  const type = m[1] as string;
  const conds: Condition[] = [];
  const body = (m[2] ?? "").trim();
  if (body) {
    for (const piece of splitTopLevel(body)) {
      const c = parseCondition(piece.trim());
      if (!c) return null;
      conds.push(c);
    }
  }
  return { type, conditions: conds, raw };
}

function splitTopLevel(s: string): string[] {
  const out: string[] = []; let depth = 0, cur = "";
  const chars = [...s];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    if (ch === ")" || ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) {
      // Inside a brace-less `field∈a,b` list, a comma followed by a bare value (no operator) continues the list.
      const rest = chars.slice(i + 1).join("");
      const nextPiece = rest.split(",")[0] ?? "";
      const looksLikeCondition = /[=<>≠∈]|\bis\b|\bin\b|\bpresent\b|\bmissing\b/i.test(nextPiece);
      if (/∈/.test(cur) && !looksLikeCondition) { cur += ch; continue; }
      out.push(cur); cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function parseCondition(s: string): Condition | null {
  let m = /^([a-zA-Z0-9_.]+)\s+is\s+not\s+null$/i.exec(s);
  if (m) return { field: m[1] as string, op: "is not null" };
  m = /^([a-zA-Z0-9_.]+)\s+is\s+null$/i.exec(s);
  if (m) return { field: m[1] as string, op: "is null" };
  m = /^([a-zA-Z0-9_.]+)\s*(?:∈|in)\s*[\{\[\(]([^\}\]\)]*)[\}\]\)]$/i.exec(s);
  if (m) return { field: m[1] as string, op: "in", value: (m[2] as string).split(/[,|]/).map((v) => v.trim()).filter(Boolean) };
  m = /^([a-zA-Z0-9_.]+)\s*∈\s*(.+)$/.exec(s);
  if (m) return { field: m[1] as string, op: "in", value: (m[2] as string).split(/[,|]/).map((v) => v.trim()).filter(Boolean) };
  m = /^([a-zA-Z0-9_.]+)\s+present$/i.exec(s);
  if (m) return { field: m[1] as string, op: "is not null" };
  m = /^([a-zA-Z0-9_.]+)\s+(?:missing|absent)$/i.exec(s);
  if (m) return { field: m[1] as string, op: "is null" };
  m = /^([a-zA-Z0-9_.]+)\s*(>=|<=|!=|≠|=|>|<)\s*(.+)$/.exec(s);
  if (m) {
    const op = (m[2] === "≠" ? "!=" : m[2]) as Op;
    return { field: m[1] as string, op, value: (m[3] as string).trim().replace(/^['"`]|['"`]$/g, "") };
  }
  // A bare `{escrowed}` or `{due_date}` means the field is present and not false.
  m = /^([a-zA-Z0-9_.]+)$/.exec(s);
  if (m) return { field: m[1] as string, op: "truthy" };
  return null;
}

function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const k of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

function typeMatches(pattern: string, type: string): boolean {
  if (pattern === type) return true;
  if (pattern.endsWith("*")) return type.startsWith(pattern.slice(0, -1));
  return false;
}

function coerceCompare(actual: unknown, expected: string): number | null {
  if (typeof actual === "number") { const n = Number(expected); return Number.isNaN(n) ? null : actual - n; }
  if (typeof actual === "bigint") { try { return Number(actual - BigInt(expected)); } catch { return null; } }
  if (typeof actual === "string") return actual < expected ? -1 : actual > expected ? 1 : 0;
  return null;
}

export function eventMatches(p: EventPattern, e: DomainEvent): boolean {
  if (!typeMatches(p.type, e.type)) return false;
  for (const c of p.conditions) {
    const v = getPath(e.payload, c.field);
    switch (c.op) {
      case "is null": if (v != null) return false; break;
      case "is not null": if (v == null) return false; break;
      case "truthy": if (v == null || v === false || v === "false") return false; break;
      case "in": if (!(c.value as readonly string[]).includes(String(v))) return false; break;
      case "=": if (String(v) !== c.value) return false; break;
      case "!=": if (String(v) === c.value) return false; break;
      default: {
        const cmp = coerceCompare(v, c.value as string);
        if (cmp === null) return false;
        if (c.op === ">" && !(cmp > 0)) return false;
        if (c.op === ">=" && !(cmp >= 0)) return false;
        if (c.op === "<" && !(cmp < 0)) return false;
        if (c.op === "<=" && !(cmp <= 0)) return false;
      }
    }
  }
  return true;
}
