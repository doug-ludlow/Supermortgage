/**
 * sm-pdf — the in-repo PDF writer (35.2 rule 2 "deterministic per build"; Integrations "pdf-writer": no vendor, no
 * Chromium; on the src/infra/files/xlsx.ts precedent). PDF 1.4, the standard 14 fonts Helvetica and Helvetica-Bold with the
 * Adobe Core 14 AFM width tables embedded for line breaking, WinAnsi encoding, `node:zlib` FlateDecode content streams, a
 * fixed `/ID` derived from the caller's seed (the payload hash) and `/CreationDate` from the command clock — identical
 * bytes for identical (template version, payload, locale, clock, build). A character outside WinAnsi is refused
 * GLYPH_UNSUPPORTED naming the character and the block; nothing is silently substituted.
 *
 * Rule 3 "layout facts come from the projection": each block of the notice block model (src/notices/render.ts) is placed
 * on a Letter page at its `page`, `y` fraction and `pt` size; the writer returns those placements with the bytes and the
 * caller's checklist evaluates its layout rules against them. Every page has a text layer: the content stream's text
 * operators carry the rendered text in reading order (block order, line order) behind a `% block <id>` marker, so
 * `textLayer(bytes)` recovers the words the block model held — the borrower's viewer, screen readers and the presence rules
 * read the same text. `readOwnPdf` parses the writer's own output back to its page model so `mergePdfs`, `stampPdf` and
 * `appendPages` re-render through the same writer (no binary merge; own-writer PDFs only).
 */
import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";

export const PRODUCER = "sm-pdf/1";
export const PAGE_W = 612; export const PAGE_H = 792; export const MARGIN = 54;
const BODY_W = PAGE_W - 2 * MARGIN; const BODY_H = PAGE_H - 2 * MARGIN;
const LEADING = 1.2;

export type FontRef = "F1" | "F2";
export interface TextOp { readonly font: FontRef; readonly pt: number; readonly x: number; readonly y: number; readonly text: string; readonly block?: string; }
export interface PdfPage { readonly ops: readonly TextOp[]; }
export interface PdfDoc { readonly pages: readonly PdfPage[]; readonly info: { readonly title: string; readonly creationDate: string }; readonly idSeed: string; }

export interface BlockInput { readonly id: string; readonly page: number; readonly yFraction: number; readonly pt: number; readonly bold: boolean; readonly text: string; }
export interface Placement { readonly block_id: string; readonly page: number; /** the drawn position of the first line, as a fraction of the body height (rule 3: what was drawn) */ readonly y_fraction: number; /** the template's declared fraction */ readonly declared_y_fraction: number; readonly pt: number; readonly bold: boolean; readonly lines: number; }
export interface WriteInput { readonly blocks: readonly BlockInput[]; readonly title: string; readonly idSeed: string; readonly creationDate: string; }
export interface Written { readonly bytes: Buffer; readonly page_count: number; readonly placements: readonly Placement[]; readonly text: string; readonly doc: PdfDoc; }

export class GlyphUnsupported extends Error {
  readonly code = "GLYPH_UNSUPPORTED" as const; readonly char: string; readonly codePoint: number; readonly block_id: string;
  constructor(char: string, block_id: string) {
    const cp = char.codePointAt(0) ?? 0;
    super(`GLYPH_UNSUPPORTED: character "${char}" (U+${cp.toString(16).toUpperCase().padStart(4, "0")}) in block ${block_id} is outside WinAnsi`);
    this.name = "GlyphUnsupported"; this.char = char; this.codePoint = cp; this.block_id = block_id;
  }
}
export class PdfNotOwn extends Error { readonly code = "PDF_NOT_OWN" as const; constructor(why: string) { super(`PDF_NOT_OWN: ${why}`); this.name = "PdfNotOwn"; } }

// ───────── WinAnsi (PDF 1.7 Appendix D.2): 0x80–0x9F are the Windows-1252 specials; 0xA0–0xFF are Latin-1 ─────────
const WIN_ANSI_HIGH: readonly [number, number][] = [[0x80, 0x20ac], [0x82, 0x201a], [0x83, 0x0192], [0x84, 0x201e], [0x85, 0x2026], [0x86, 0x2020], [0x87, 0x2021], [0x88, 0x02c6], [0x89, 0x2030], [0x8a, 0x0160], [0x8b, 0x2039], [0x8c, 0x0152], [0x8e, 0x017d],
  [0x91, 0x2018], [0x92, 0x2019], [0x93, 0x201c], [0x94, 0x201d], [0x95, 0x2022], [0x96, 0x2013], [0x97, 0x2014], [0x98, 0x02dc], [0x99, 0x2122], [0x9a, 0x0161], [0x9b, 0x203a], [0x9c, 0x0153], [0x9e, 0x017e], [0x9f, 0x0178]];
const ENCODE = new Map<number, number>(); const DECODE = new Array<number>(256).fill(-1);
for (let c = 0x20; c < 0x7f; c++) { ENCODE.set(c, c); DECODE[c] = c; }
for (let c = 0xa0; c <= 0xff; c++) { ENCODE.set(c, c); DECODE[c] = c; }
for (const [code, cp] of WIN_ANSI_HIGH) { ENCODE.set(cp, code); DECODE[code] = cp; }
// the control characters a template's text may carry (a tab, a line break) have no glyph: each renders as a space — the text layer says so (a
// non-breaking space, U+00A0, is a WinAnsi glyph of its own and is kept: `wrap` never splits on it)
ENCODE.set(0x09, 0x20); ENCODE.set(0x0a, 0x20); ENCODE.set(0x0d, 0x20);

/** Encode one string to WinAnsi bytes; a character outside the encoding is refused naming the block. */
export function encodeWinAnsi(text: string, blockId: string): Buffer {
  const out: number[] = [];
  for (const ch of text) { const cp = ch.codePointAt(0)!; const code = ENCODE.get(cp); if (code === undefined) throw new GlyphUnsupported(ch, blockId); out.push(code); }
  return Buffer.from(out);
}
export function decodeWinAnsi(bytes: Uint8Array): string { let s = ""; for (const b of bytes) { const cp = DECODE[b]!; s += cp >= 0 ? String.fromCodePoint(cp) : "�"; } return s; }
/** True when every character of `text` has a WinAnsi glyph. */
export function winAnsiEncodable(text: string): boolean { for (const ch of text) if (!ENCODE.has(ch.codePointAt(0)!)) return false; return true; }
export function firstUnsupported(text: string): string | null { for (const ch of text) if (!ENCODE.has(ch.codePointAt(0)!)) return ch; return null; }

// ───────── Adobe Core 14 AFM widths (Helvetica, Helvetica-Bold), indexed by WinAnsi code ─────────
const W_ASCII_H = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const W_ASCII_B = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];
const W_LATIN_H = [278, 333, 556, 556, 556, 556, 260, 556, 333, 737, 370, 556, 584, 333, 737, 333, 400, 584, 333, 333, 333, 556, 537, 278, 333, 333, 365, 556, 834, 834, 834, 611, 667, 667, 667, 667, 667, 667, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278, 722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611, 556, 556, 556, 556, 556, 556, 889, 500, 556, 556, 556, 556, 278, 278, 278, 278, 556, 556, 556, 556, 556, 556, 556, 584, 611, 556, 556, 556, 556, 500, 556, 500];
const W_LATIN_B = [278, 333, 556, 556, 556, 556, 280, 556, 333, 737, 370, 556, 584, 333, 737, 333, 400, 584, 333, 333, 333, 611, 556, 278, 333, 333, 365, 556, 834, 834, 834, 611, 722, 722, 722, 722, 722, 722, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278, 722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611, 556, 556, 556, 556, 556, 556, 889, 556, 556, 556, 556, 556, 278, 278, 278, 278, 611, 611, 611, 611, 611, 611, 611, 584, 611, 611, 611, 611, 611, 556, 611, 556];
const W_HIGH_H: Record<number, number> = { 0x80: 556, 0x82: 222, 0x83: 556, 0x84: 333, 0x85: 1000, 0x86: 556, 0x87: 556, 0x88: 333, 0x89: 1000, 0x8a: 667, 0x8b: 333, 0x8c: 1000, 0x8e: 611, 0x91: 222, 0x92: 222, 0x93: 333, 0x94: 333, 0x95: 350, 0x96: 556, 0x97: 1000, 0x98: 333, 0x99: 1000, 0x9a: 500, 0x9b: 333, 0x9c: 944, 0x9e: 500, 0x9f: 667 };
const W_HIGH_B: Record<number, number> = { 0x80: 556, 0x82: 278, 0x83: 556, 0x84: 500, 0x85: 1000, 0x86: 556, 0x87: 556, 0x88: 333, 0x89: 1000, 0x8a: 667, 0x8b: 333, 0x8c: 1000, 0x8e: 611, 0x91: 278, 0x92: 278, 0x93: 500, 0x94: 500, 0x95: 350, 0x96: 556, 0x97: 1000, 0x98: 333, 0x99: 1000, 0x9a: 556, 0x9b: 333, 0x9c: 944, 0x9e: 500, 0x9f: 667 };
function widthTable(ascii: number[], latin: number[], high: Record<number, number>): Int16Array {
  const t = new Int16Array(256);
  for (let i = 0; i < ascii.length; i++) t[0x20 + i] = ascii[i]!;
  for (let i = 0; i < latin.length; i++) t[0xa0 + i] = latin[i]!;
  for (const [code, w] of Object.entries(high)) t[Number(code)] = w;
  return t;
}
export const WIDTHS: Record<FontRef, Int16Array> = { F1: widthTable(W_ASCII_H, W_LATIN_H, W_HIGH_H), F2: widthTable(W_ASCII_B, W_LATIN_B, W_HIGH_B) };
/** The advance width of WinAnsi-encoded bytes at `pt` points. */
export function textWidth(encoded: Uint8Array, font: FontRef, pt: number): number { let w = 0; const t = WIDTHS[font]; for (const b of encoded) w += t[b]!; return (w * pt) / 1000; }

// ───────── layout: blocks → text ops ─────────
function wrap(text: string, font: FontRef, pt: number, maxWidth: number, blockId: string): string[] {
  const words = text.split(/[ \t\r\n\f\v]+/).filter((w) => w.length);   // never on U+00A0: a non-breaking space stays inside its word
  const lines: string[] = []; let line = "";
  const width = (s: string) => textWidth(encodeWinAnsi(s, blockId), font, pt);
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (width(candidate) <= maxWidth || !line) {
      if (width(candidate) <= maxWidth) { line = candidate; continue; }
      // a single word wider than the line: break it by characters
      let piece = "";
      for (const ch of word) { if (width(piece + ch) > maxWidth && piece) { lines.push(piece); piece = ch; } else piece += ch; }
      line = piece; continue;
    }
    lines.push(line); line = word;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

/**
 * The layout flows: a block starts at its declared page and y, or below the last line already drawn on that page when the
 * declared position would overprint it (a long amount-due box pushes the blocks under it down; the Form 1098 instructions
 * follow one another); a block that runs past the bottom margin continues on the next page, below whatever that page
 * already holds. The placement reports the page the block's first line was drawn on (rule 3: the placement is what was drawn).
 */
export function layoutBlocks(blocks: readonly BlockInput[]): { pages: PdfPage[]; placements: Placement[] } {
  const pages: TextOp[][] = [];
  const pageOps = (p: number): TextOp[] => { while (pages.length < p) pages.push([]); return pages[p - 1]!; };
  const placements: Placement[] = [];
  const lastBaseline = new Map<number, number>();   // per page: the baseline of the lowest line drawn so far
  const below = (page: number, y: number, pt: number): number => { const last = lastBaseline.get(page); return last === undefined ? y : Math.min(y, last - LEADING * pt); };
  for (const b of blocks) {
    const font: FontRef = b.bold ? "F2" : "F1";
    const pt = b.pt > 0 ? b.pt : 10;
    const lines = wrap(b.text, font, pt, BODY_W, b.id);
    let page = Math.max(1, Math.floor(b.page) || 1);
    let y = below(page, PAGE_H - MARGIN - Math.min(Math.max(b.yFraction, 0), 1) * BODY_H - pt, pt);
    let first = true; let drawnOn = page; let drawnY = y;
    for (const line of lines) {
      while (y < MARGIN) { page += 1; y = below(page, PAGE_H - MARGIN - pt, pt); }
      if (first) { drawnOn = page; drawnY = y; }
      pageOps(page).push({ font, pt, x: MARGIN, y: round2(y), text: line, ...(first ? { block: b.id } : {}) });
      lastBaseline.set(page, y);
      first = false;
      y -= LEADING * pt;
    }
    if (!lines.length) pageOps(page);
    placements.push({ block_id: b.id, page: drawnOn, y_fraction: round4((PAGE_H - MARGIN - pt - drawnY) / BODY_H), declared_y_fraction: b.yFraction, pt, bold: b.bold, lines: lines.length });
  }
  if (!pages.length) pages.push([]);
  return { pages: pages.map((ops) => ({ ops })), placements };
}
const round2 = (n: number): number => Math.round(n * 100) / 100;
const round4 = (n: number): number => Math.round(n * 10000) / 10000;

// ───────── the bytes ─────────
let renders = 0;
/** How many times the writer produced bytes in this process (T11: the integrity run never renders). */
export function writerStats(): { renders: number } { return { renders }; }

function pdfString(encoded: Uint8Array): string {
  let s = "(";
  for (const b of encoded) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) s += "\\" + String.fromCharCode(b);
    else if (b < 0x20 || b > 0x7e) s += "\\" + b.toString(8).padStart(3, "0");
    else s += String.fromCharCode(b);
  }
  return s + ")";
}
const num = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, ""));

function contentStream(page: PdfPage): Buffer {
  const parts: string[] = [];
  for (const op of page.ops) {
    if (op.block !== undefined) parts.push(`% block ${op.block}\n`);
    parts.push(`BT /${op.font} ${num(op.pt)} Tf 1 0 0 1 ${num(op.x)} ${num(op.y)} Tm ${pdfString(encodeWinAnsi(op.text, op.block ?? "?"))} Tj ET\n`);
  }
  return Buffer.from(parts.join(""), "latin1");
}
const pdfDate = (iso: string): string => { const d = new Date(iso); const p = (n: number) => String(n).padStart(2, "0"); return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}+00'00'`; };
const escapeText = (s: string): string => s.replace(/[\\()]/g, (c) => "\\" + c).replace(/[^\x20-\x7e]/g, "?");

/** Write a page model to PDF 1.4 bytes (deterministic: fixed object order, FlateDecode level 6, /ID from the seed, /CreationDate from the clock). */
export function writeDoc(doc: PdfDoc): Buffer {
  renders += 1;
  const objects: Buffer[] = [];
  const add = (body: string | Buffer): number => { objects.push(Buffer.isBuffer(body) ? body : Buffer.from(body, "latin1")); return objects.length; };
  const pageCount = doc.pages.length;
  const firstPageObj = 5; const infoObj = firstPageObj + 2 * pageCount;
  add(`<< /Type /Catalog /Pages 2 0 R >>`);
  add(`<< /Type /Pages /Kids [${doc.pages.map((_, i) => `${firstPageObj + 2 * i} 0 R`).join(" ")}] /Count ${pageCount} >>`);
  add(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`);
  add(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`);
  doc.pages.forEach((page, i) => {
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${firstPageObj + 2 * i + 1} 0 R >>`);
    const deflated = deflateSync(contentStream(page), { level: 6 });
    add(Buffer.concat([Buffer.from(`<< /Length ${deflated.length} /Filter /FlateDecode >>\nstream\n`, "latin1"), deflated, Buffer.from(`\nendstream`, "latin1")]));
  });
  add(`<< /Producer (${PRODUCER}) /Creator (Supermortgage 35.2) /Title (${escapeText(doc.info.title)}) /CreationDate (${pdfDate(doc.info.creationDate)}) >>`);
  const id = createHash("sha256").update(doc.idSeed).digest("hex").slice(0, 32);
  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  const offsets: number[] = []; let pos = chunks[0]!.length;
  objects.forEach((body, i) => { offsets.push(pos); const head = Buffer.from(`${i + 1} 0 obj\n`, "latin1"); const tail = Buffer.from(`\nendobj\n`, "latin1"); chunks.push(head, body, tail); pos += head.length + body.length + tail.length; });
  const xrefPos = pos;
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)].join("");
  chunks.push(Buffer.from(xref, "latin1"));
  chunks.push(Buffer.from(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${infoObj} 0 R /ID [<${id}> <${id}>] >>\nstartxref\n${xrefPos}\n%%EOF\n`, "latin1"));
  return Buffer.concat(chunks);
}

/** The block model → placements + bytes + the text layer in reading order. */
export function writePdf(input: WriteInput): Written {
  const { pages, placements } = layoutBlocks(input.blocks);
  const doc: PdfDoc = { pages, info: { title: input.title, creationDate: input.creationDate }, idSeed: input.idSeed };
  const bytes = writeDoc(doc);
  return { bytes, page_count: pages.length, placements, text: textOf(doc), doc };
}
const textOf = (doc: PdfDoc): string => doc.pages.map((p) => p.ops.map((o) => o.text).join("\n")).join("\n");

// ───────── reading the writer's own output ─────────
export interface TextLayer { readonly pages: readonly string[]; readonly text: string; readonly blocks: readonly { id: string; page: number; text: string }[]; }

function parseString(src: string, from: number): { text: Uint8Array; end: number } {
  const out: number[] = []; let i = from + 1; let depth = 1;
  while (i < src.length) {
    const c = src.charCodeAt(i);
    if (c === 0x5c) {
      const n = src[i + 1]!;
      if (/[0-7]/.test(n)) { const m = /^[0-7]{1,3}/.exec(src.slice(i + 1))![0]; out.push(parseInt(m, 8)); i += 1 + m.length; continue; }
      const map: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12, "(": 0x28, ")": 0x29, "\\": 0x5c };
      out.push(map[n] ?? n.charCodeAt(0)); i += 2; continue;
    }
    if (c === 0x28) depth++; else if (c === 0x29) { depth--; if (depth === 0) return { text: Uint8Array.from(out), end: i + 1 }; }
    out.push(c); i++;
  }
  throw new PdfNotOwn("unterminated string");
}

/** The content streams of every page, in page order (the writer's own structure: /Type /Page objects with a /Contents reference each). */
export function contentStreams(bytes: Buffer): Buffer[] {
  const src = bytes.toString("latin1");
  if (!src.startsWith("%PDF-1.4")) throw new PdfNotOwn("not a PDF 1.4 header");
  const objs = new Map<number, { start: number; end: number }>();
  const re = /(\d+) 0 obj\n/g;
  for (let m = re.exec(src); m; m = re.exec(src)) { const start = m.index + m[0].length; objs.set(Number(m[1]), { start, end: start }); }
  const pageRe = /<< \/Type \/Page \/Parent 2 0 R .*? \/Contents (\d+) 0 R >>/g;
  const contentIds: number[] = [];
  for (let m = pageRe.exec(src); m; m = pageRe.exec(src)) contentIds.push(Number(m[1]));
  const kids = /\/Kids \[([^\]]*)\]/.exec(src)?.[1] ?? "";
  const kidIds = [...kids.matchAll(/(\d+) 0 R/g)].map((m) => Number(m[1]));
  // order the content streams by the page tree, not by object number
  const byPage = new Map<number, number>();
  const pageObjRe = /(\d+) 0 obj\n<< \/Type \/Page \/Parent 2 0 R .*? \/Contents (\d+) 0 R >>/g;
  for (let m = pageObjRe.exec(src); m; m = pageObjRe.exec(src)) byPage.set(Number(m[1]), Number(m[2]));
  const ordered = kidIds.length ? kidIds.map((k) => byPage.get(k)).filter((x): x is number => x !== undefined) : contentIds;
  return ordered.map((id) => {
    const o = objs.get(id); if (!o) throw new PdfNotOwn(`content object ${id} missing`);
    const head = /<< \/Length (\d+) \/Filter \/FlateDecode >>\nstream\n/.exec(src.slice(o.start, o.start + 200)); if (!head) throw new PdfNotOwn(`content object ${id} is not a FlateDecode stream`);
    const dataStart = o.start + head.index + head[0].length;
    return inflateSync(bytes.subarray(dataStart, dataStart + Number(head[1])));
  });
}

/** The text layer: every page's text operators in stream order, WinAnsi-decoded, with the block markers. */
export function textLayer(bytes: Buffer): TextLayer {
  const pages: string[] = []; const blocks: { id: string; page: number; text: string }[] = [];
  contentStreams(bytes).forEach((stream, pi) => {
    const src = stream.toString("latin1");
    const lines: string[] = []; let current: { id: string; page: number; text: string } | null = null;
    let i = 0;
    while (i < src.length) {
      if (src.startsWith("% block ", i)) { const end = src.indexOf("\n", i); const id = src.slice(i + 8, end < 0 ? src.length : end); current = { id, page: pi + 1, text: "" }; blocks.push(current); i = end < 0 ? src.length : end + 1; continue; }
      const c = src[i];
      if (c === "(") { const { text, end } = parseString(src, i); const decoded = decodeWinAnsi(text); lines.push(decoded); if (current) current.text = current.text ? `${current.text} ${decoded}` : decoded; i = end; continue; }
      i++;
    }
    pages.push(lines.join("\n"));
  });
  return { pages, text: pages.join("\n"), blocks };
}

/** The writer's own output back to its page model (fonts, sizes, positions, text, block markers); refuses another producer's file. */
export function readOwnPdf(bytes: Buffer): PdfDoc {
  const src = bytes.toString("latin1");
  if (!src.includes(`/Producer (${PRODUCER})`)) throw new PdfNotOwn("not an sm-pdf file (no /Producer sm-pdf/1)");
  const title = /\/Title \(((?:\\.|[^)\\])*)\)/.exec(src)?.[1]?.replace(/\\(.)/g, "$1") ?? "";
  const cd = /\/CreationDate \(D:(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(src);
  const creationDate = cd ? `${cd[1]}-${cd[2]}-${cd[3]}T${cd[4]}:${cd[5]}:${cd[6]}.000Z` : "1970-01-01T00:00:00.000Z";
  const id = /\/ID \[<([0-9a-f]{32})>/.exec(src)?.[1] ?? "";
  const pages: PdfPage[] = contentStreams(bytes).map((stream) => {
    const s = stream.toString("latin1"); const ops: TextOp[] = []; let block: string | undefined; let i = 0;
    while (i < s.length) {
      if (s.startsWith("% block ", i)) { const end = s.indexOf("\n", i); block = s.slice(i + 8, end); i = end + 1; continue; }
      if (s.startsWith("BT ", i)) {
        const m = /^BT \/(F[12]) ([\d.]+) Tf 1 0 0 1 ([\d.-]+) ([\d.-]+) Tm /.exec(s.slice(i)); if (!m) throw new PdfNotOwn("unexpected text operator");
        const strStart = i + m[0].length; const { text, end } = parseString(s, strStart);
        ops.push({ font: m[1] as FontRef, pt: Number(m[2]), x: Number(m[3]), y: Number(m[4]), text: decodeWinAnsi(text), ...(block !== undefined ? { block } : {}) });
        block = undefined; i = end; continue;
      }
      i++;
    }
    return { ops };
  });
  return { pages, info: { title, creationDate }, idSeed: `own:${id}` };
}

/** One merged PDF: for each part a cover page (its own ops) then the part's pages, re-rendered by the writer. */
export function mergePdfs(parts: readonly { doc: Buffer; cover: readonly TextOp[] }[], info: { title: string; creationDate: string; idSeed: string }): Written {
  const pages: PdfPage[] = [];
  for (const part of parts) { pages.push({ ops: part.cover }); pages.push(...readOwnPdf(part.doc).pages); }
  const doc: PdfDoc = { pages, info: { title: info.title, creationDate: info.creationDate }, idSeed: info.idSeed };
  return { bytes: writeDoc(doc), page_count: pages.length, placements: [], text: textOf(doc), doc };
}
/** The document with text stamped onto its pages (a signature field's stamp) — re-rendered, so the text layer carries the stamps. */
export function stampPdf(bytes: Buffer, stamps: readonly { page: number; x: number; y: number; text: string; pt?: number; bold?: boolean; block?: string }[], info: { creationDate: string; idSeed: string }): Written {
  const own = readOwnPdf(bytes);
  const pages = own.pages.map((p) => ({ ops: [...p.ops] }));
  for (const st of stamps) { while (pages.length < st.page) pages.push({ ops: [] }); pages[st.page - 1]!.ops.push({ font: st.bold ? "F2" : "F1", pt: st.pt ?? 10, x: st.x, y: st.y, text: st.text, ...(st.block ? { block: st.block } : {}) }); }
  const doc: PdfDoc = { pages, info: { title: own.info.title, creationDate: info.creationDate }, idSeed: info.idSeed };
  return { bytes: writeDoc(doc), page_count: pages.length, placements: [], text: textOf(doc), doc };
}
/** The document with pages appended (a signature page from blocks) — re-rendered. */
export function appendPages(bytes: Buffer, blocks: readonly BlockInput[], info: { creationDate: string; idSeed: string }): Written {
  const own = readOwnPdf(bytes);
  const extra = layoutBlocks(blocks);
  const pages: PdfPage[] = [...own.pages, ...extra.pages];
  const doc: PdfDoc = { pages, info: { title: own.info.title, creationDate: info.creationDate }, idSeed: info.idSeed };
  return { bytes: writeDoc(doc), page_count: pages.length, placements: extra.placements.map((p) => ({ ...p, page: p.page + own.pages.length })), text: textOf(doc), doc };
}
/** A page of text ops laid out from blocks (a cover sheet). */
export function pageFromBlocks(blocks: readonly BlockInput[]): readonly TextOp[] { return layoutBlocks(blocks).pages.flatMap((p) => p.ops); }

export const sha256Hex = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
