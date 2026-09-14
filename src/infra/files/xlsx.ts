/**
 * xlsx-reader / writer (33.1 "xlsx-reader": in-repo, dependency-free — the
 * zip's central directory, `node:zlib` inflateRawSync per entry, the
 * shared-strings and sheet XML; serial dates and numbers to strings).
 *
 * The reader understands enough of SpreadsheetML to turn every sheet into a
 * `string[][]`: workbook sheet order and names, the workbook relationships for
 * sheet paths, shared strings (plain `si/t` and rich-text runs `si/r/t`
 * concatenated, phonetic runs ignored), and `sheetData` rows/cells with
 * A1 references, cell types `s|inlineStr|b|str|n|e`, `<v>` and `<is><t>`.
 * The writer produces one-sheet workbooks with inline strings, numbers as
 * `<v>`, booleans as `t="b"`, deflate-raw (method 8) entries with CRC32s,
 * a central directory and an end-of-central-directory record — a file this
 * reader, Excel and LibreOffice open. No vendor.
 */
import { inflateRawSync, deflateRawSync } from "node:zlib";

// ───────── CRC32 ─────────
const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = (CRC_TABLE[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ───────── ZIP (minimal central-directory reader/writer) ─────────
const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

type ZipEntry = { name: string; method: number; crc: number; compressedSize: number; size: number; localOffset: number };

function u16(b: Uint8Array, o: number): number { return (b[o] as number) | ((b[o + 1] as number) << 8); }
function u32(b: Uint8Array, o: number): number { return ((b[o] as number) | ((b[o + 1] as number) << 8) | ((b[o + 2] as number) << 16) | ((b[o + 3] as number) << 24)) >>> 0; }
const utf8 = new TextDecoder("utf-8");
const utf8enc = new TextEncoder();

function readCentralDirectory(bytes: Uint8Array): ZipEntry[] {
  // The EOCD is at the end, followed only by a comment of at most 65535 bytes.
  const min = Math.max(0, bytes.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= min; i--) {
    if (u32(bytes, i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("xlsx: not a zip file (no end-of-central-directory record)");
  const count = u16(bytes, eocd + 10);
  let p = u32(bytes, eocd + 16);
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (u32(bytes, p) !== SIG_CENTRAL) throw new Error("xlsx: corrupt central directory");
    const method = u16(bytes, p + 10);
    const crc = u32(bytes, p + 16);
    const compressedSize = u32(bytes, p + 20);
    const size = u32(bytes, p + 24);
    const nameLen = u16(bytes, p + 28);
    const extraLen = u16(bytes, p + 30);
    const commentLen = u16(bytes, p + 32);
    const localOffset = u32(bytes, p + 42);
    const name = utf8.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    entries.push({ name, method, crc, compressedSize, size, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// ───────── bounds: an upload never allocates past them (a RangeError answers 400 at the ops route and the console) ─────────
/** The most one zip part may inflate to (a sheet of 118 columns × 1,048,576 rows stays well under it). */
export const XLSX_PART_MAX = 256 * 1024 * 1024;
/** The most every part of one workbook may inflate to together. */
export const XLSX_TOTAL_MAX = 512 * 1024 * 1024;
/** Excel's own sheet limits: 1,048,576 rows × 16,384 columns (XFD). */
export const XLSX_MAX_ROWS = 1_048_576;
export const XLSX_MAX_COLS = 16_384;

/**
 * One entry, inflated to no more than the size its central-directory record declares (and never past XLSX_PART_MAX): a
 * deflate bomb whose declared size lies is cut off by `maxOutputLength`, one whose declared size is honest but huge is refused
 * before a byte is inflated, and a part whose inflated length or CRC32 differs from the record is refused as corrupt.
 */
function readEntry(bytes: Uint8Array, e: ZipEntry): Uint8Array {
  const h = e.localOffset;
  if (h + 30 > bytes.length || u32(bytes, h) !== SIG_LOCAL) throw new Error(`xlsx: corrupt local header for ${e.name}`);
  if (e.size > XLSX_PART_MAX) throw new RangeError(`xlsx: part ${e.name} declares ${e.size} bytes, over the ${XLSX_PART_MAX}-byte limit`);
  const nameLen = u16(bytes, h + 26);
  const extraLen = u16(bytes, h + 28);
  const start = h + 30 + nameLen + extraLen;
  if (start + e.compressedSize > bytes.length) throw new RangeError(`xlsx: part ${e.name} runs past the end of the file`);
  const data = bytes.subarray(start, start + e.compressedSize);
  let out: Uint8Array;
  if (e.method === 0) out = data;
  else if (e.method === 8) {
    try { out = new Uint8Array(inflateRawSync(data, { maxOutputLength: Math.max(1, e.size) })); }
    catch (err) { throw new RangeError(`xlsx: part ${e.name} does not inflate to its declared ${e.size} bytes (${err instanceof Error ? err.message : String(err)})`); }
  } else throw new Error(`xlsx: unsupported compression method ${e.method} for ${e.name}`);
  if (out.length !== e.size) throw new RangeError(`xlsx: part ${e.name} is ${out.length} bytes, not the declared ${e.size}`);
  if (crc32(out) !== e.crc) throw new RangeError(`xlsx: part ${e.name} fails its CRC32`);
  return out;
}

/** Read every entry of a zip into a name → bytes map; the declared sizes are summed before any part is inflated (XLSX_TOTAL_MAX). */
export function unzip(bytes: Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const entries = readCentralDirectory(bytes);
  let declared = 0;
  for (const e of entries) { declared += e.size; if (declared > XLSX_TOTAL_MAX) throw new RangeError(`xlsx: the workbook's parts declare over ${XLSX_TOTAL_MAX} bytes together`); }
  for (const e of entries) out.set(e.name.replace(/^\/+/, ""), readEntry(bytes, e));
  return out;
}

function putU16(b: number[], v: number): void { b.push(v & 0xff, (v >>> 8) & 0xff); }
function putU32(b: number[], v: number): void { b.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff); }

/** Write a zip with every entry deflate-raw (method 8), CRC32 and sizes in both headers, a central directory and an EOCD. */
export function zip(entries: readonly { name: string; data: Uint8Array }[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: number[] = [];
  let offset = 0;
  // A fixed DOS date/time (2000-01-01 00:00) — the writer is deterministic.
  const dosTime = 0;
  const dosDate = ((2000 - 1980) << 9) | (1 << 5) | 1;
  for (const e of entries) {
    const name = utf8enc.encode(e.name);
    const comp = new Uint8Array(deflateRawSync(e.data, { level: 6 }));
    const crc = crc32(e.data);
    const local: number[] = [];
    putU32(local, SIG_LOCAL);
    putU16(local, 20);          // version needed
    putU16(local, 0x0800);      // flags: UTF-8 names
    putU16(local, 8);           // method deflate
    putU16(local, dosTime); putU16(local, dosDate);
    putU32(local, crc); putU32(local, comp.length); putU32(local, e.data.length);
    putU16(local, name.length); putU16(local, 0);
    const localHdr = new Uint8Array(local);
    parts.push(localHdr, name, comp);
    putU32(central, SIG_CENTRAL);
    putU16(central, 20); putU16(central, 20);
    putU16(central, 0x0800); putU16(central, 8);
    putU16(central, dosTime); putU16(central, dosDate);
    putU32(central, crc); putU32(central, comp.length); putU32(central, e.data.length);
    putU16(central, name.length); putU16(central, 0); putU16(central, 0);
    putU16(central, 0); putU16(central, 0); putU32(central, 0);
    putU32(central, offset);
    for (const c of name) central.push(c);
    offset += localHdr.length + name.length + comp.length;
  }
  const cd = new Uint8Array(central);
  const eocd: number[] = [];
  putU32(eocd, SIG_EOCD);
  putU16(eocd, 0); putU16(eocd, 0);
  putU16(eocd, entries.length); putU16(eocd, entries.length);
  putU32(eocd, cd.length); putU32(eocd, offset);
  putU16(eocd, 0);
  parts.push(cd, new Uint8Array(eocd));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ───────── XML tokenizer (not a full parser) ─────────
type XmlToken =
  | { kind: "open"; name: string; attrs: Record<string, string>; selfClosing: boolean }
  | { kind: "close"; name: string }
  | { kind: "text"; text: string };

function decodeEntities(s: string): string {
  if (s.indexOf("&") < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (m, e: string) => {
    if (e === "amp") return "&";
    if (e === "lt") return "<";
    if (e === "gt") return ">";
    if (e === "quot") return '"';
    if (e === "apos") return "'";
    const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : m;
  });
}

/** Local name — namespace prefixes (`x:sheet`, `ss:t`) are dropped. */
function localName(n: string): string { const i = n.indexOf(":"); return i < 0 ? n : n.slice(i + 1); }

const ATTR_RE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function* tokenize(xml: string): Generator<XmlToken> {
  let i = 0;
  const n = xml.length;
  while (i < n) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) { const t = xml.slice(i); if (t.length) yield { kind: "text", text: decodeEntities(t) }; break; }
    if (lt > i) yield { kind: "text", text: decodeEntities(xml.slice(i, lt)) };
    if (xml.startsWith("<!--", lt)) { const e = xml.indexOf("-->", lt + 4); i = e < 0 ? n : e + 3; continue; }
    if (xml.startsWith("<![CDATA[", lt)) { const e = xml.indexOf("]]>", lt + 9); const t = xml.slice(lt + 9, e < 0 ? n : e); yield { kind: "text", text: t }; i = e < 0 ? n : e + 3; continue; }
    if (xml.startsWith("<?", lt)) { const e = xml.indexOf("?>", lt + 2); i = e < 0 ? n : e + 2; continue; }
    if (xml.startsWith("<!", lt)) { const e = xml.indexOf(">", lt + 2); i = e < 0 ? n : e + 1; continue; }
    // A tag: find its closing '>' outside quotes.
    let j = lt + 1; let q: string | null = null;
    while (j < n) {
      const ch = xml[j] as string;
      if (q) { if (ch === q) q = null; }
      else if (ch === '"' || ch === "'") q = ch;
      else if (ch === ">") break;
      j++;
    }
    const body = xml.slice(lt + 1, j);
    i = j + 1;
    if (body.startsWith("/")) { yield { kind: "close", name: localName(body.slice(1).trim()) }; continue; }
    const selfClosing = body.endsWith("/");
    const inner = selfClosing ? body.slice(0, -1) : body;
    const m = /^([^\s/>]+)/.exec(inner);
    const name = localName(m ? (m[1] as string) : "");
    const attrs: Record<string, string> = {};
    ATTR_RE.lastIndex = m ? m[0].length : 0;
    let a: RegExpExecArray | null;
    while ((a = ATTR_RE.exec(inner)) !== null) attrs[localName(a[1] as string)] = decodeEntities(a[2] ?? a[3] ?? "");
    yield { kind: "open", name, attrs, selfClosing };
  }
}

// ───────── A1 references ─────────
/** "A" → 0, "Z" → 25, "AA" → 26, "DN" → 117. */
export function columnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
/** 0 → "A", 117 → "DN". */
export function columnLetters(index: number): string {
  let s = ""; let n = index + 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
function parseRef(ref: string): { col: number; row: number } | null {
  const m = /^([A-Za-z]+)(\d+)$/.exec(ref);
  return m ? { col: columnIndex(m[1] as string), row: parseInt(m[2] as string, 10) } : null;
}

// ───────── Reader ─────────
function text(entries: Map<string, Uint8Array>, name: string): string | null {
  const b = entries.get(name);
  return b ? utf8.decode(b) : null;
}

function readSharedStrings(xml: string | null): string[] {
  const out: string[] = [];
  if (!xml) return out;
  let inSi = false; let inRPh = false; let depthT = 0; let cur = "";
  for (const tok of tokenize(xml)) {
    if (tok.kind === "open") {
      if (tok.name === "si") { inSi = true; cur = ""; if (tok.selfClosing) { out.push(""); inSi = false; } }
      else if (tok.name === "rPh") { if (!tok.selfClosing) inRPh = true; }
      else if (tok.name === "t" && inSi && !inRPh && !tok.selfClosing) depthT++;
    } else if (tok.kind === "close") {
      if (tok.name === "si") { if (inSi) out.push(cur); inSi = false; }
      else if (tok.name === "rPh") inRPh = false;
      else if (tok.name === "t" && depthT > 0) depthT--;
    } else if (depthT > 0) cur += tok.text;
  }
  return out;
}

function readSheet(xml: string, shared: readonly string[]): string[][] {
  const rows: string[][] = [];
  let rowNo = 0;                       // 1-based row of the row element being read
  let cells: string[] | null = null;
  let cell: { col: number; type: string } | null = null;
  let colCursor = 0;
  let inV = false; let inIsT = false; let inIs = false;
  let vText = ""; let isText = "";
  const setCell = (): void => {
    if (!cell || !cells) return;
    const t = cell.type;
    let value: string;
    if (t === "s") { const idx = parseInt(vText.trim(), 10); value = shared[idx] ?? ""; }
    else if (t === "inlineStr") value = isText;
    else if (t === "b") value = vText.trim() === "1" ? "TRUE" : vText.trim() === "0" ? "FALSE" : vText.trim() === "" ? "" : vText.trim().toLowerCase() === "true" ? "TRUE" : "FALSE";
    else value = vText;            // n, str, e, d and untyped: the stored text
    while (cells.length < cell.col) cells.push("");
    cells[cell.col] = value;
    colCursor = cell.col + 1;
    cell = null;
  };
  for (const tok of tokenize(xml)) {
    if (tok.kind === "open") {
      if (tok.name === "row") {
        const r = tok.attrs["r"] ? parseInt(tok.attrs["r"], 10) : rowNo + 1;
        rowNo = Number.isFinite(r) && r > 0 ? r : rowNo + 1;
        if (rowNo > XLSX_MAX_ROWS) throw new RangeError(`xlsx: row ${rowNo} is past Excel's ${XLSX_MAX_ROWS}-row limit`);
        while (rows.length < rowNo - 1) rows.push([]);
        cells = [];
        rows[rowNo - 1] = cells;
        colCursor = 0;
        if (tok.selfClosing) cells = null;
      } else if (tok.name === "c" && cells) {
        const ref = tok.attrs["r"] ? parseRef(tok.attrs["r"]) : null;
        const col = ref ? ref.col : colCursor;
        if (col >= XLSX_MAX_COLS) throw new RangeError(`xlsx: column ${col + 1} is past Excel's ${XLSX_MAX_COLS}-column limit`);
        cell = { col, type: tok.attrs["t"] ?? "n" };
        vText = ""; isText = "";
        if (tok.selfClosing) setCell();
      } else if (tok.name === "v" && cell) { if (!tok.selfClosing) inV = true; }
      else if (tok.name === "is" && cell) { if (!tok.selfClosing) inIs = true; }
      else if (tok.name === "t" && inIs && !tok.selfClosing) inIsT = true;
      else if (tok.name === "rPh" && inIs) { /* phonetic runs are skipped by the text guard below */ inIsT = false; }
    } else if (tok.kind === "close") {
      if (tok.name === "v") inV = false;
      else if (tok.name === "t") inIsT = false;
      else if (tok.name === "is") inIs = false;
      else if (tok.name === "c") setCell();
      else if (tok.name === "row") { cell = null; cells = null; }
    } else {
      if (inV) vText += tok.text;
      else if (inIsT) isText += tok.text;
    }
  }
  return rows;
}

function resolveTarget(target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  // Relative to xl/ (the workbook part's folder); collapse any "../".
  const segs: string[] = ["xl"];
  for (const s of target.split("/")) {
    if (s === "" || s === ".") continue;
    if (s === "..") segs.pop(); else segs.push(s);
  }
  return segs.join("/");
}

/**
 * Every sheet in workbook order, every cell a string ("" when empty). Numbers
 * come back as their stored decimal text (a date cell is its serial, e.g.
 * "45920"); shared strings, inline strings and booleans ("TRUE"/"FALSE") are
 * resolved.
 */
export function readXlsx(bytes: Uint8Array): { sheets: { name: string; rows: string[][] }[] } {
  const entries = unzip(bytes);
  const workbook = text(entries, "xl/workbook.xml");
  if (workbook === null) throw new Error("xlsx: xl/workbook.xml missing");
  const rels = text(entries, "xl/_rels/workbook.xml.rels") ?? "";
  const relTargets = new Map<string, string>();
  for (const tok of tokenize(rels)) {
    if (tok.kind === "open" && tok.name === "Relationship" && tok.attrs["Id"] !== undefined) relTargets.set(tok.attrs["Id"], tok.attrs["Target"] ?? "");
  }
  const sheetDefs: { name: string; rId: string | undefined; sheetId: string | undefined }[] = [];
  for (const tok of tokenize(workbook)) {
    if (tok.kind === "open" && tok.name === "sheet") sheetDefs.push({ name: tok.attrs["name"] ?? "", rId: tok.attrs["id"], sheetId: tok.attrs["sheetId"] });
  }
  const shared = readSharedStrings(text(entries, "xl/sharedStrings.xml"));
  const sheets: { name: string; rows: string[][] }[] = [];
  sheetDefs.forEach((def, i) => {
    let path: string | null = null;
    if (def.rId !== undefined && relTargets.has(def.rId)) path = resolveTarget(relTargets.get(def.rId) as string);
    if (path === null || !entries.has(path)) {
      // No relationship part (or a broken one): fall back to the conventional path.
      const guess = `xl/worksheets/sheet${def.sheetId ?? String(i + 1)}.xml`;
      path = entries.has(guess) ? guess : `xl/worksheets/sheet${i + 1}.xml`;
    }
    const xml = text(entries, path);
    if (xml === null) throw new Error(`xlsx: worksheet part ${path} for sheet "${def.name}" missing`);
    sheets.push({ name: def.name, rows: readSheet(xml, shared) });
  });
  return { sheets };
}

// ───────── Writer ─────────
export function xmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&apos;");
}

/** One-sheet workbook: inline strings, numbers as `<v>`, booleans `t="b"`, null/"" cells omitted. */
export function writeXlsx(rows: readonly (string | number | boolean | null)[][], sheetName: string = "Sheet1"): Uint8Array {
  const sheetRows: string[] = [];
  let maxCol = 0;
  rows.forEach((row, ri) => {
    const cells: string[] = [];
    row.forEach((v, ci) => {
      if (v === null || v === undefined) return;
      const ref = `${columnLetters(ci)}${ri + 1}`;
      if (ci + 1 > maxCol) maxCol = ci + 1;
      if (typeof v === "number") {
        if (!Number.isFinite(v)) return;
        cells.push(`<c r="${ref}"><v>${String(v)}</v></c>`);
      } else if (typeof v === "boolean") {
        cells.push(`<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`);
      } else {
        if (v === "") return;
        const space = /^\s|\s$/.test(v) ? ' xml:space="preserve"' : "";
        cells.push(`<c r="${ref}" t="inlineStr"><is><t${space}>${xmlEscape(v)}</t></is></c>`);
      }
    });
    if (cells.length) sheetRows.push(`<row r="${ri + 1}">${cells.join("")}</row>`);
  });
  const dim = rows.length && maxCol ? `<dimension ref="A1:${columnLetters(maxCol - 1)}${rows.length}"/>` : `<dimension ref="A1"/>`;
  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    dim + `<sheetData>${sheetRows.join("")}</sheetData></worksheet>`;
  const safeName = xmlEscape(sheetName.replace(/[\\/?*[\]:]/g, "_").slice(0, 31) || "Sheet1");
  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets><sheet name="${safeName}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
    `</Relationships>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
    `</Types>`;
  return zip([
    { name: "[Content_Types].xml", data: utf8enc.encode(contentTypes) },
    { name: "_rels/.rels", data: utf8enc.encode(rootRels) },
    { name: "xl/workbook.xml", data: utf8enc.encode(workbookXml) },
    { name: "xl/_rels/workbook.xml.rels", data: utf8enc.encode(workbookRels) },
    { name: "xl/worksheets/sheet1.xml", data: utf8enc.encode(sheetXml) },
  ]);
}

// ───────── Excel serial dates ─────────
const MS_PER_DAY = 86_400_000;
/**
 * 1900 date system with the Lotus leap-year bug: serial 1 = 1900-01-01,
 * serial 60 = the non-existent 1900-02-29 (tolerated, returned as such),
 * serial 61 = 1900-03-01, 25569 = 1970-01-01, 45920 = 2025-09-20.
 * Fractional serials (a time of day) are truncated to the day.
 */
export function excelSerialToIsoDate(serial: number): string {
  if (!Number.isFinite(serial)) throw new RangeError(`excelSerialToIsoDate: not a serial: ${serial}`);
  const day = Math.floor(serial);
  if (day === 60) return "1900-02-29";
  // 1899-12-30 epoch for serials past the phantom day; 1899-12-31 before it.
  const epoch = day > 60 ? Date.UTC(1899, 11, 30) : Date.UTC(1899, 11, 31);
  const d = new Date(epoch + day * MS_PER_DAY);
  const y = d.getUTCFullYear(); const m = d.getUTCMonth() + 1; const dd = d.getUTCDate();
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

/** The inverse for the writer's callers: ISO "YYYY-MM-DD" → 1900-system serial (dates after 1900-02-28 only). */
export function isoDateToExcelSerial(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new RangeError(`isoDateToExcelSerial: not an ISO date: ${iso}`);
  const ms = Date.UTC(parseInt(m[1] as string, 10), parseInt(m[2] as string, 10) - 1, parseInt(m[3] as string, 10));
  const days = Math.round((ms - Date.UTC(1899, 11, 30)) / MS_PER_DAY);
  return days > 60 ? days : days - 1;
}
