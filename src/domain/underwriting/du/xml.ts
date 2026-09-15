/**
 * The XML half of 23.6 that runtime and tests share: a small reader (elements, attributes in document order, text, no
 * DTD — enough for the corpus and for what the emitter writes; anything else is refused rather than guessed at) and the
 * golden diff of Business rule 7 — an emitted document against a sample, container by container in document order,
 * then arc by arc, after normalizing whitespace and pairing the sample's labels with ours. The diff is the
 * `diffDuDocumentAgainstSample` tool's engine (src/app/tools/section23-6.ts) as well as the round-trip test's, so it
 * lives here and not in the test-only sample loader (23.6 Open question 1: the loader is never imported by runtime;
 * src/domain/underwriting/fixtures/du-sample-loader.ts re-exports these for the tests).
 */

export interface XmlElement {
  readonly name: string;
  readonly attrs: readonly (readonly [string, string])[];
  readonly children: XmlElement[];
  text: string;
}

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, ref: string) => {
    if (ref.startsWith("#x")) return String.fromCodePoint(parseInt(ref.slice(2), 16));
    if (ref.startsWith("#")) return String.fromCodePoint(parseInt(ref.slice(1), 10));
    const e = ENTITIES[ref];
    if (e === undefined) throw new Error(`unknown entity ${whole}`);
    return e;
  });
}

export function parseXml(source: string): XmlElement {
  const text = source.startsWith("﻿") ? source.slice(1) : source;
  const stack: { el: XmlElement; text: string[] }[] = [];
  let root: XmlElement | null = null;
  let i = 0;
  const fail = (what: string): never => { throw new Error(`XML: ${what} at offset ${i}`); };
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt === -1) { if (text.slice(i).trim()) fail("text after the root element"); break; }
    if (lt > i) { const chunk = text.slice(i, lt); if (stack.length) stack[stack.length - 1]!.text.push(chunk); else if (chunk.trim()) fail("text outside the root element"); }
    i = lt;
    if (text.startsWith("<!--", i)) { const end = text.indexOf("-->", i); if (end === -1) fail("unterminated comment"); i = end + 3; continue; }
    if (text.startsWith("<?", i)) { const end = text.indexOf("?>", i); if (end === -1) fail("unterminated processing instruction"); i = end + 2; continue; }
    if (text.startsWith("<![CDATA[", i)) { const end = text.indexOf("]]>", i); if (end === -1) fail("unterminated CDATA"); if (!stack.length) fail("CDATA outside the root"); stack[stack.length - 1]!.text.push(text.slice(i + 9, end)); i = end + 3; continue; }
    if (text.startsWith("<!", i)) fail("a DTD or declaration is not supported");
    if (text.startsWith("</", i)) {
      const end = text.indexOf(">", i); if (end === -1) fail("unterminated end tag");
      const name = text.slice(i + 2, end).trim();
      const top = stack.pop(); if (!top) fail("end tag with no open element");
      if (top!.el.name !== name) fail(`</${name}> closes <${top!.el.name}>`);
      top!.el.text = top!.text.join("");
      i = end + 1; continue;
    }
    // A start tag: the name, then attributes, then > or />.
    const m = /^<([A-Za-z_][\w.:-]*)/.exec(text.slice(i, i + 200));
    if (!m) fail("malformed start tag");
    let j = i + m![0].length;
    const attrs: [string, string][] = [];
    let selfClosing = false;
    for (;;) {
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text.startsWith("/>", j)) { selfClosing = true; j += 2; break; }
      if (text[j] === ">") { j++; break; }
      const am = /^([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(text.slice(j, j + 4000));
      if (!am) { i = j; fail("malformed attribute"); }
      attrs.push([am![1]!, decodeEntities(am![2] ?? am![3] ?? "")]);
      j += am![0].length;
    }
    const el: XmlElement = { name: m![1]!, attrs, children: [], text: "" };
    if (stack.length) stack[stack.length - 1]!.el.children.push(el);
    else if (root) fail("a second root element");
    else root = el;
    if (!selfClosing) stack.push({ el, text: [] });
    i = j;
  }
  if (stack.length) fail(`unclosed <${stack[stack.length - 1]!.el.name}>`);
  if (!root) fail("no root element");
  decodeText(root!);
  return root!;
}

function decodeText(el: XmlElement): void {
  el.text = decodeEntities(el.text);
  for (const c of el.children) decodeText(c);
}

export const attr = (el: XmlElement, name: string): string | undefined => el.attrs.find(([k]) => k === name)?.[1];

// ---------------------------------------------------------------------------------------------------------------------
// The diff (rule 7): container by container in document order, then arc by arc

export interface DuDiff {
  readonly equal: boolean;
  /** The first differing XPath (instance form: `[n]` on a repeated sibling). */
  readonly xpath?: string;
  readonly detail?: string;
  /** The sample's labels → ours, as the walk paired them. */
  readonly labels: ReadonlyMap<string, string>;
}

const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();

/** `emitted` against `sample`, after whitespace normalization and mapping the sample's labels (and their SequenceNumber twins) to ours. */
export function diffDuDocument(emitted: string | Uint8Array, sample: string | Uint8Array): DuDiff {
  const ours = parseXml(typeof emitted === "string" ? emitted : new TextDecoder().decode(emitted));
  const theirs = parseXml(typeof sample === "string" ? sample : new TextDecoder().decode(sample));
  const labels = new Map<string, string>();
  const differ = (xpath: string, detail: string): DuDiff => ({ equal: false, xpath, detail, labels });
  const walk = (a: XmlElement, b: XmlElement, xpath: string): DuDiff | null => {
    if (a.name !== b.name) return differ(xpath, `emitted <${a.name}>, sample <${b.name}>`);
    const am = new Map(a.attrs); const bm = new Map(b.attrs);
    for (const key of new Set([...am.keys(), ...bm.keys()])) {
      const av = am.get(key); const bv = bm.get(key);
      if (av === undefined || bv === undefined) return differ(`${xpath}/@${key}`, av === undefined ? `sample has ${key}="${bv}", emitted has none` : `emitted has ${key}="${av}", sample has none`);
      if (key === "xlink:label") {
        const prior = labels.get(bv);
        if (prior !== undefined && prior !== av) return differ(`${xpath}/@${key}`, `sample label ${bv} paired with ${prior} earlier and ${av} here`);
        if ([...labels.values()].includes(av) && prior === undefined) return differ(`${xpath}/@${key}`, `emitted label ${av} is carried twice`);
        labels.set(bv, av);
        continue;
      }
      if (key === "SequenceNumber") continue;
      if (key === "xlink:from" || key === "xlink:to") {
        const mapped = labels.get(bv);
        if (mapped === undefined) return differ(`${xpath}/@${key}`, `sample arc names ${bv}, a label the walk did not pair`);
        if (mapped !== av) return differ(`${xpath}/@${key}`, `sample ${bv} (= ${mapped}), emitted ${av}`);
        continue;
      }
      if (av !== bv) return differ(`${xpath}/@${key}`, `emitted "${av}", sample "${bv}"`);
    }
    if (collapse(a.text) !== collapse(b.text)) return differ(xpath, `emitted ${JSON.stringify(collapse(a.text))}, sample ${JSON.stringify(collapse(b.text))}`);
    const step = (parent: XmlElement, c: XmlElement, i: number): string => {
      const same = parent.children.filter((s) => s.name === c.name);
      return same.length > 1 ? `${c.name}[${same.indexOf(c) + 1}]` : c.name;
    };
    for (let i = 0; i < Math.max(a.children.length, b.children.length); i++) {
      const ac = a.children[i]; const bc = b.children[i];
      if (!ac || !bc) return differ(`${xpath}/${step(ac ? a : b, (ac ?? bc)!, i)}`, ac ? `emitted has <${ac.name}> where the sample has nothing` : `sample has <${bc!.name}> where the emitted document has nothing`);
      const d = walk(ac, bc, `${xpath}/${step(b, bc, i)}`);
      if (d) return d;
    }
    return null;
  };
  return walk(ours, theirs, "MESSAGE") ?? { equal: true, labels };
}
