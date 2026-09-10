/**
 * Dependency-free renderer for the registry's Handlebars-shaped templates.
 * Supported: `{{path}}` (HTML-escaped), `{{{path}}}` (raw), `{{money path}}`
 * (cents → $1,234.56), `{{date path}}` (YYYY-MM-DD → Month D, YYYY),
 * `{{pct path}}`, `{{#if path}}…{{else}}…{{/if}}`, `{{#unless path}}…{{/unless}}`,
 * `{{#each path}}…{{/each}}` (with `{{this}}`, `{{@index}}`), and
 * `{{#block "id" page=1 y=0.2 pt=12 bold}}…{{/block}}` which tags a region
 * so layout rules can be checked without a browser.
 *
 * Output is `text` (tags stripped, for presence rules), `html`, and the list
 * of `blocks` with their layout facts. Payloads are hashed canonically so the
 * `notices` row is content-addressed.
 */
import { createHash } from "node:crypto";

export interface RenderedBlock { readonly id: string; readonly page: number; readonly yFraction: number; readonly pt: number; readonly bold: boolean; readonly text: string; }
export interface Rendered { readonly html: string; readonly text: string; readonly blocks: readonly RenderedBlock[]; readonly payloadHash: string; }

export function canonicalJson(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (typeof x === "bigint") return x.toString();
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === "object") return Object.fromEntries(Object.keys(x as Record<string, unknown>).sort().map((k) => [k, norm((x as Record<string, unknown>)[k])]));
    return x;
  };
  return JSON.stringify(norm(v));
}
export const payloadHash = (payload: unknown): string => createHash("sha256").update(canonicalJson(payload)).digest("hex");

export function getPath(obj: unknown, path: string): unknown {
  if (path === "this" || path === ".") return obj;
  let cur: unknown = obj;
  for (const k of path.split(".")) { if (cur == null || typeof cur !== "object") return undefined; cur = (cur as Record<string, unknown>)[k]; }
  return cur;
}
const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const truthy = (v: unknown): boolean => Array.isArray(v) ? v.length > 0 : typeof v === "bigint" ? v !== 0n : !!v && v !== "false";

export function money(v: unknown): string {
  const c = typeof v === "bigint" ? v : typeof v === "number" ? BigInt(Math.round(v)) : typeof v === "string" && /^-?\d+$/.test(v) ? BigInt(v) : null;
  if (c === null) return "";
  const neg = c < 0n; const a = neg ? -c : c;
  const dollars = (a / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ","); const cents = (a % 100n).toString().padStart(2, "0");
  return `${neg ? "-" : ""}$${dollars}.${cents}`;
}
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export function longDate(v: unknown): string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(v)) return "";
  return `${MONTHS[Number(v.slice(5, 7)) - 1]} ${Number(v.slice(8, 10))}, ${v.slice(0, 4)}`;
}
export function pct(v: unknown): string { return typeof v === "string" || typeof v === "number" ? `${Number(v).toFixed(3)}%` : ""; }

interface Frame { readonly data: unknown; readonly index?: number; }

export function render(source: string, payload: Record<string, unknown>): Rendered {
  const blocks: RenderedBlock[] = [];
  const html = renderSection(source, [{ data: payload }], blocks);
  const text = html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/\s+/g, " ").trim();
  return { html, text, blocks, payloadHash: payloadHash(payload) };
}

function lookup(frames: readonly Frame[], path: string): unknown {
  if (path === "@index") return frames[frames.length - 1]?.index;
  for (let i = frames.length - 1; i >= 0; i--) { const v = getPath(frames[i]!.data, path); if (v !== undefined) return v; }
  return undefined;
}

const OPEN = /\{\{#(if|unless|each|block)\s+([^}]*)\}\}/;
function findClose(src: string, tag: string, from: number): { elseAt: number; closeAt: number; closeLen: number } {
  // Depth counts every section kind so an {{else}} inside a nested block/each/if is never attributed to the outer section.
  const re = /\{\{#(?:if|unless|each|block)\b|\{\{\/(?:if|unless|each|block)\}\}|\{\{else\}\}/g;
  re.lastIndex = from;
  let depth = 1, elseAt = -1;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (m[0].startsWith("{{#")) depth++;
    else if (m[0] === "{{else}}") { if (depth === 1 && elseAt < 0) elseAt = m.index; }
    else {
      depth--;
      if (depth === 0) {
        if (m[0] !== `{{/${tag}}}`) throw new SyntaxError(`expected {{/${tag}}} but found ${m[0]}`);
        return { elseAt, closeAt: m.index, closeLen: m[0].length };
      }
    }
  }
  throw new SyntaxError(`unclosed {{#${tag}}}`);
}

function renderSection(src: string, frames: Frame[], blocks: RenderedBlock[]): string {
  let out = "", i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    const m = OPEN.exec(rest);
    const plainEnd = m ? i + m.index : src.length;
    out += renderInline(src.slice(i, plainEnd), frames);
    if (!m) break;
    const tag = m[1]!, arg = m[2]!.trim();
    const bodyStart = i + m.index + m[0].length;
    const { elseAt, closeAt, closeLen } = findClose(src, tag, bodyStart);
    const body = src.slice(bodyStart, elseAt >= 0 ? elseAt : closeAt);
    const elseBody = elseAt >= 0 ? src.slice(elseAt + 8, closeAt) : "";
    if (tag === "if" || tag === "unless") {
      const v = truthy(lookup(frames, arg));
      out += renderSection((tag === "if") === v ? body : elseBody, frames, blocks);
    } else if (tag === "each") {
      const arr = lookup(frames, arg);
      if (Array.isArray(arr) && arr.length) arr.forEach((item, idx) => { out += renderSection(body, [...frames, { data: item, index: idx }], blocks); });
      else out += renderSection(elseBody, frames, blocks);
    } else {
      const idm = /^"([^"]+)"/.exec(arg); if (!idm) throw new SyntaxError(`block needs an id: ${arg}`);
      const attrs = Object.fromEntries([...arg.slice(idm[0].length).matchAll(/(\w+)(?:=([\w.]+))?/g)].map((a) => [a[1]!, a[2] ?? "true"]));
      const inner = renderSection(body, frames, blocks);
      const text = inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      blocks.push({ id: idm[1]!, page: Number(attrs["page"] ?? 1), yFraction: Number(attrs["y"] ?? 0), pt: Number(attrs["pt"] ?? 10), bold: attrs["bold"] === "true", text });
      out += `<section data-block="${idm[1]}" data-page="${attrs["page"] ?? 1}" data-y="${attrs["y"] ?? 0}" data-pt="${attrs["pt"] ?? 10}"${attrs["bold"] === "true" ? ' class="bold"' : ""}>${inner}</section>`;
    }
    i = closeAt + closeLen;
  }
  return out;
}

function renderInline(s: string, frames: readonly Frame[]): string {
  return s.replace(/\{\{\{\s*([^}]+?)\s*\}\}\}|\{\{\s*([^#/}][^}]*?)\s*\}\}/g, (_m, raw: string | undefined, expr: string | undefined) => {
    if (raw !== undefined) return String(lookup(frames, raw) ?? "");
    const e = expr!.trim();
    if (e === "else") return "";
    const helper = /^(money|date|pct|upper)\s+(.+)$/.exec(e);
    if (helper) {
      const v = lookup(frames, helper[2]!);
      switch (helper[1]) { case "money": return money(v); case "date": return longDate(v); case "pct": return pct(v); default: return escapeHtml(String(v ?? "")).toUpperCase(); }
    }
    const v = lookup(frames, e);
    return escapeHtml(v === undefined || v === null ? "" : typeof v === "bigint" ? v.toString() : String(v));
  });
}
