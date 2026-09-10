/**
 * Content-rule engine (7.1): presence/absence rules run as regexes over the
 * rendered text, data rules against the immutable payload, layout rules
 * against the renderer's block facts (page, y-fraction, font size, bold),
 * conditional rules only when their `when` predicate holds, cross_ref rules
 * pass iff the referenced rule passed. A notice passes iff no `block` rule
 * fails; `warn` failures are recorded and surfaced to the disclosures agent.
 */
import type { ContentRule, TemplateVersion, Predicate } from "./registry.ts";
import type { Rendered } from "./render.ts";
import { getPath, render } from "./render.ts";

export interface RuleResult { readonly rule_id: string; readonly citation: string; readonly severity: "block" | "warn"; readonly passed: boolean; readonly skipped?: boolean; readonly message: string; readonly detail?: string; }
export interface ChecklistResult { readonly template_version: string; readonly passed: boolean; readonly results: readonly RuleResult[]; readonly blocking: readonly RuleResult[]; readonly warnings: readonly RuleResult[]; }

const num = (v: unknown): number | string | null => typeof v === "bigint" ? Number(v) : typeof v === "number" || typeof v === "string" ? v : v === null || v === undefined ? null : String(v);

export function evaluatePredicate(p: Predicate, payload: unknown): unknown {
  if (p === null || typeof p !== "object" || Array.isArray(p)) return p;
  const o = p as Record<string, unknown>;
  const [op] = Object.keys(o);
  if (!op) return true;
  const args = o[op];
  const ev = (x: unknown) => evaluatePredicate(x, payload);
  const pair = (): [unknown, unknown] => { const a = args as unknown[]; return [ev(a[0]), ev(a[1])]; };
  switch (op) {
    case "var": return getPath(payload, String(args));
    case "present": { const v = getPath(payload, String(args)); return v !== undefined && v !== null && v !== ""; }
    case "matches": { const a = args as [string, string]; const v = getPath(payload, a[0]); return typeof v === "string" && new RegExp(a[1]).test(v); }
    case "==": { const [a, b] = pair(); return num(a) === num(b) || String(a) === String(b); }
    case "!=": { const [a, b] = pair(); return !(num(a) === num(b) || String(a) === String(b)); }
    case ">": { const [a, b] = pair(); return Number(a) > Number(b); }
    case ">=": { const [a, b] = pair(); return Number(a) >= Number(b); }
    case "<": { const [a, b] = pair(); return Number(a) < Number(b); }
    case "<=": { const [a, b] = pair(); return Number(a) <= Number(b); }
    case "and": return (args as unknown[]).every((x) => !!ev(x));
    case "or": return (args as unknown[]).some((x) => !!ev(x));
    case "!": return !ev(Array.isArray(args) ? args[0] : args);
    case "in": { const [a, list] = pair(); return Array.isArray(list) && list.map(String).includes(String(a)); }
    default: throw new RangeError(`unknown predicate op ${op}`);
  }
}

function evaluateRule(r: ContentRule, payload: Record<string, unknown>, rendered: Rendered, results: Map<string, RuleResult>): RuleResult {
  const base = { rule_id: r.rule_id, citation: r.citation, severity: r.severity, message: r.message };
  if (r.when !== undefined && !evaluatePredicate(r.when, payload)) return { ...base, passed: true, skipped: true };
  switch (r.kind) {
    case "presence": { const ok = new RegExp(r.selector, "i").test(rendered.text); return { ...base, passed: ok, ...(ok ? {} : { detail: `text does not match /${r.selector}/` }) }; }
    case "absence": { const ok = !new RegExp(r.selector, "i").test(rendered.text); return { ...base, passed: ok, ...(ok ? {} : { detail: `text must not match /${r.selector}/` }) }; }
    case "data_equality": case "conditional": {
      const ok = !!evaluatePredicate(r.predicate ?? { present: r.selector }, payload);
      return { ...base, passed: ok, ...(ok ? {} : { detail: `predicate false for ${r.selector}` }) };
    }
    case "data_range": {
      const v = num(getPath(payload, r.selector));
      if (v === null) return { ...base, passed: false, detail: `${r.selector} missing` };
      const n = typeof v === "string" ? (/^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v) : v;
      const min = r.range?.min, max = r.range?.max;
      const ok = (min === undefined || n >= min) && (max === undefined || n <= max);
      return { ...base, passed: ok, ...(ok ? {} : { detail: `${r.selector}=${String(n)} outside [${String(min ?? "-∞")}, ${String(max ?? "∞")}]` }) };
    }
    case "layout": {
      const b = rendered.blocks.find((x) => x.id === r.selector);
      if (!b) return { ...base, passed: false, detail: `block ${r.selector} not rendered` };
      const c = r.layout ?? {};
      const problems: string[] = [];
      if (c.page !== undefined && b.page !== c.page) problems.push(`page ${b.page} ≠ ${c.page}`);
      if (c.maxYFraction !== undefined && b.yFraction > c.maxYFraction) problems.push(`y ${b.yFraction} > ${c.maxYFraction}`);
      if (c.minPt !== undefined && b.pt < c.minPt) problems.push(`${b.pt}pt < ${c.minPt}pt`);
      if (c.bold && !b.bold) problems.push("not bold");
      if (c.minFontRatio !== undefined) { const body = rendered.blocks.find((x) => x.id === "body"); if (body && b.pt / body.pt < c.minFontRatio) problems.push(`font ratio ${(b.pt / body.pt).toFixed(2)} < ${c.minFontRatio}`); }
      return { ...base, passed: problems.length === 0, ...(problems.length ? { detail: problems.join(", ") } : {}) };
    }
    case "cross_ref": { const ref = results.get(r.selector); const ok = ref !== undefined && ref.passed; return { ...base, passed: ok, ...(ok ? {} : { detail: `depends on ${r.selector}` }) }; }
  }
}

export function evaluateChecklist(v: TemplateVersion, payload: Record<string, unknown>, rendered: Rendered): ChecklistResult {
  const results = new Map<string, RuleResult>();
  for (const r of [...v.contentRules, ...v.layoutRules]) results.set(r.rule_id, evaluateRule(r, payload, rendered, results));
  const all = [...results.values()];
  const blocking = all.filter((r) => !r.passed && r.severity === "block");
  const warnings = all.filter((r) => !r.passed && r.severity === "warn");
  return { template_version: v.version, passed: blocking.length === 0, results: all, blocking, warnings };
}

/** Publish gate (7.1 acceptance): the version's block rules must pass against its own sample payload. */
export function publishCheck(v: TemplateVersion): readonly string[] {
  const r = evaluateChecklist(v, v.samplePayload, render(v.source, v.samplePayload));
  return r.blocking.map((b) => `${b.rule_id} (${b.citation}): ${b.detail ?? b.message}`);
}
