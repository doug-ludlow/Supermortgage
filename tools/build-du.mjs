#!/usr/bin/env node
/**
 * Turn Fannie Mae's DU specification into the tables the serializer will emit
 * against.
 *
 * EVERY mapping below is exhaustive and throws on an unrecognized value, so a
 * new DU Spec release that adds a format, a conditionality phrase or an
 * enumeration stops the build rather than landing as a silent default. A DU
 * file that is silently wrong is a file Fannie Mae rejects days later, with no
 * local symptom at all.
 *
 * The inputs arrive from two places, and the split is the reason `--verify`
 * has the shape it does.
 *
 * The XSD chain is VENDORED, in `src/infra/integrations/du-schema/xsd/`. Nine
 * files, the transitive closure of the DU wrapper's imports, with a README
 * naming where each one came from. It is a frozen 2016 MISMO publication plus
 * a dated Fannie release, and it is what makes an emitted document either
 * legal or not — so everything derived from it, which is element order, is
 * checkable on any machine that has this repository and nothing else.
 *
 * The workbook is NOT, and is read from a directory named by DU_SPEC_DIR. Not
 * for its size — it is 728K — but because it is a moving document, reissued
 * several times a year, and git keeps every copy forever. What IS committed
 * from it is the TypeScript below — enum member names, lengths, cardinality,
 * conditionality — which is our derived work product.
 *
 * So `--verify` does five jobs and says which ones it did and which it skipped:
 *
 *   - the du_* enum CHECK diff reads two kinds of committed file — the SQL
 *     migrations under `db/migrations/` and the generated `enums.ts` — and
 *     needs no spec directory at all. It runs once `db/migrations/*_du_graph.sql`
 *     exists (23.5's data-model migration, Phase 3 of the DU hand-off) and
 *     reports itself skipped, by name, until then. The convention it reads is
 *     stated below.
 *   - the schema-order diff always runs, against the vendored chain. It
 *     re-derives every child sequence in `order.ts` from the XSDs and fails if
 *     one moved, which catches both a hand-edited table and a re-vendored XSD.
 *   - the arcrole corpus diff always runs, against the vendored samples. It
 *     re-counts which arcs the eighteen shipped test cases carry and fails if
 *     `arcroles.ts` says otherwise, or names an arcrole a sample uses and the
 *     table does not describe.
 *   - the per-kind asset CHECK diff reads the three AssetType lists out of
 *     `db/migrations/*_du_graph.sql` and fails unless they partition the values
 *     `enums.ts` files under 2a.1, 2b.1 and 4d.1. Skipped, by name, until that
 *     migration exists.
 *   - the workbook diff runs only when DU_SPEC_DIR is set, and is what catches
 *     the generated files' workbook-derived halves drifting from the spec they
 *     claim to come from. Unset it to skip that last one; a DU_SPEC_DIR that
 *     does not hold the workbook fails rather than skipping.
 *
 * THE MIGRATION CONVENTION THE ENUM CHECK DIFF READS. A DU-enumerated column
 * on a `du_*` table is `text` with a CHECK whose members are spelled as an IN
 * list, and a COMMENT ON COLUMN naming the DU data point:
 *
 *   CREATE TABLE du_assets (
 *     asset_type text CHECK (asset_type IN ('Bond', 'CheckingAccount', …)),
 *     …
 *   );
 *   COMMENT ON COLUMN du_assets.asset_type IS 'DU AssetType';
 *
 * Exactly: the comment literal is `DU ` followed by the data point's name as
 * the DU Map spells it (`AssetType`, `LiabilityType`, `DU:VerificationReportType`),
 * optionally continued with `. ` and prose. The data point must be one that
 * DU_DATA_POINT_FOR_ENUM maps to a `Du*` enum; a comment naming any other
 * stops the check. The CHECK may sit on the column, in a named table
 * constraint, or inside a larger expression — `kind <> 'DEPOSIT_ACCOUNT' OR
 * (asset_type IN (…) AND …)` — and a column may be named by several: the
 * members diffed are the UNION of every `<column> IN ('…', …)` list in any
 * CREATE TABLE or ALTER TABLE statement on that table, in any migration,
 * outside `$$ … $$` function bodies and outside comments. `NOT IN` lists are
 * exclusions and are not read. A column with the comment and no IN list
 * fails; a column with an IN list and no `DU …` comment is ours and is not
 * diffed. Identifiers may be bare or double-quoted.
 *
 * The per-kind asset CHECK diff reads `db/migrations/*_du_graph.sql` (exactly
 * one file) for `ADD CONSTRAINT <name> CHECK (` — the three names are in
 * ASSET_TYPE_SECTIONS — up to the balancing parenthesis, and takes the
 * `asset_type IN (…)` list inside each.
 *
 *   node tools/build-du.mjs            # write src/domain/underwriting/du/generated/
 *   node tools/build-du.mjs --verify   # fail if it would change
 */

import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join, relative } from "node:path";
import { inflateRawSync } from "node:zlib";
import { SAMPLES_DIR, XSD_DIR } from "../src/infra/integrations/du-schema/index.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_REL = "src/domain/underwriting/du/generated";
const OUT_DIR = resolve(ROOT, OUT_REL);
/**
 * The migration that gives each kind of asset the AssetType values its URLA
 * section carries, and that the enum CHECK diff waits for.
 *
 * Found by name rather than pinned, because it is 23.5's data-model migration
 * and is not written yet. The three lists inside it are the partition this
 * script derives, and a check that reads them is the only thing that keeps
 * them from being three hand-typed lists that drift. Until the glob matches,
 * both checks that read migrations report themselves skipped, by name — never
 * passed: a green line over a diff that read nothing is the exact failure this
 * script exists to refuse.
 */
export const DU_GRAPH_MIGRATION_GLOB = "db/migrations/*_du_graph.sql";

export function duGraphMigrationPaths(root = ROOT) {
  const dir = resolve(root, "db/migrations");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith("_du_graph.sql"))
    .sort()
    .map((name) => `db/migrations/${name}`);
}

/** Every migration in the tree, in order, as the enum CHECK diff reads them. */
export function migrationSources(root = ROOT) {
  const dir = resolve(root, "db/migrations");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({ file: `db/migrations/${name}`, sql: readFileSync(join(dir, name), "utf8") }));
}

/**
 * The DU Spec release these mappings were read against.
 *
 * It is asserted, not detected. Fannie Mae reissues this workbook several times
 * a year, and a mapping that was exhaustive against 1.9.3 is only a guess
 * against 1.9.4 — so a newer workbook stops the build and somebody re-reads the
 * tabs. The map tab is named for the version, which is why one constant does
 * both jobs.
 */
const SPEC_VERSION = "1.9.3";

const TABS = {
  frontCover: "Front Cover",
  columnDescription: "Column Description",
  map: `DU Map v${SPEC_VERSION}`,
  enumerations: "DU Enumerations",
  cardinality: "Cardinality",
  arcRoles: "ArcRoles",
};

/**
 * Where the workbook lives under DU_SPEC_DIR.
 *
 * One entry, and it stays a map because the shape of the error — "it must
 * contain:", then a list — is what makes a missing file actionable, and a
 * second licensed input that never gets vendored would join it here.
 */
const SPEC_FILES = {
  workbook: `DU Specs/DU_Specification v${SPEC_VERSION}.xlsx`,
};

/**
 * The four schema files the order table is derived from, vendored.
 *
 * `XSD_DIR` and `SAMPLES_DIR` are imported from
 * src/infra/integrations/du-schema/index.ts, so this script, the validator and
 * the FAKE DU port reach the chain and the samples by one path.
 *
 * They are named rather than globbed because the ORDER matters — see
 * `parseSchemas` — and because `src/infra/integrations/du-schema/xsd/` holds
 * nine files while only these four declare types this script reads. The other
 * five arrive through imports that `xmllint` follows and this parser does not.
 *
 * The MISMO entry resolves to the `Combined/` build for a reason the README
 * repeats: the split build's `MISMO_3.4.0_B324.xsd` declares no complex types
 * at all — all 3,228 of them arrive through an `xsd:include` — while the
 * `Combined/` build carries them inline. Nothing here follows an include, and
 * teaching it to would buy the same bytes by a longer route.
 *
 * The samples are Fannie Mae's eighteen shipped test cases, vendored beside
 * the chain. They are the only evidence in the repository about which arcs a
 * real DU submission actually carries, which is why `arcroles.ts` records it:
 * an arc the tab describes and no shipped case exercises is one whose
 * endpoints nobody has ever seen a working document use, and a table that
 * does not say so makes the two kinds look equally settled.
 */
const XSD_FILES = {
  mismo: resolve(XSD_DIR, "MISMO_3.4.0_B324.xsd"),
  wrapper: resolve(XSD_DIR, "DU_Wrapper_3.4.0_B324.xsd"),
  duExtension: resolve(XSD_DIR, "DU_ExtensionV3_4.xsd"),
  uladExtension: resolve(XSD_DIR, "ULAD_ExtensionV3_4.xsd"),
};

/**
 * The workbook is not here — and `unset` says which of the two reasons it is,
 * because they are not the same event.
 *
 * Leaving DU_SPEC_DIR unset is how a machine without the licensed workbook says
 * so, and `--verify` skips the workbook third on it. Setting the variable is
 * the expression of intent to check, so a set-but-wrong path is a failure: a
 * typo'd or moved corpus that reported itself as "no workbook on this machine"
 * would hand back a green build that verified less than it looked like.
 */
export class SpecUnavailableError extends Error {
  constructor(message, { unset }) {
    super(message);
    this.unset = unset;
  }
}

export function resolveSpecFiles(env = process.env) {
  const dir = env.DU_SPEC_DIR;
  if (!dir) {
    throw new SpecUnavailableError(
      "DU_SPEC_DIR is not set.\n" +
        "  Fannie Mae's workbook is licensed, is reissued several times a year, and is\n" +
        "  deliberately not in this repository — unlike the XSD chain, which is vendored\n" +
        "  in src/infra/integrations/du-schema/xsd. Point DU_SPEC_DIR at the directory holding it, for\n" +
        "  example:\n" +
        "    DU_SPEC_DIR='/path/to/DU Integration' npm run du:build\n" +
        "  It must contain:\n" +
        Object.values(SPEC_FILES)
          .map((f) => `    ${f}\n`)
          .join(""),
      { unset: true },
    );
  }
  const paths = {};
  const missing = [];
  for (const [key, rel] of Object.entries(SPEC_FILES)) {
    const full = join(dir, rel);
    if (!existsSync(full)) missing.push(rel);
    paths[key] = full;
  }
  if (missing.length) {
    throw new SpecUnavailableError(
      `DU_SPEC_DIR is set to ${JSON.stringify(dir)} but these files are missing:\n` +
        missing.map((f) => `    ${f}\n`).join("") +
        "  Check the directory, or unset DU_SPEC_DIR to skip the workbook check.",
      { unset: false },
    );
  }
  return paths;
}

// ── Reading .xlsx ──────────────────────────────────────────────────────────
// Hand-rolled: this runs inside `npm test`, and a dependency there is a
// dependency everybody installs to type-check. An .xlsx is a zip of XML, both
// of which Node already has.

function unzip(path) {
  const buf = readFileSync(path);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error(`${path} is not a zip archive`);
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error(`${path}: bad central directory`);
    const method = buf.readUInt16LE(off + 10);
    const compressedSize = buf.readUInt32LE(off + 20);
    const nameLength = buf.readUInt16LE(off + 28);
    const extraLength = buf.readUInt16LE(off + 30);
    const commentLength = buf.readUInt16LE(off + 32);
    const localOffset = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLength);
    const localNameLength = buf.readUInt16LE(localOffset + 26);
    const localExtraLength = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const data = buf.subarray(start, start + compressedSize);
    if (method !== 0 && method !== 8) throw new Error(`${path}: unsupported zip method ${method}`);
    files.set(name, method === 0 ? data : inflateRawSync(data));
    off += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");
}

function readSharedStrings(xml) {
  const out = [];
  for (const si of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    let text = "";
    for (const t of si[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) text += decodeEntities(t[1]);
    out.push(text);
  }
  return out;
}

function columnIndex(ref) {
  let n = 0;
  for (const ch of ref) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * Read one worksheet as an array of rows, each row an array of cell strings.
 *
 * Rows keep the numbers the spreadsheet shows, so an error message can name a
 * cell somebody can go and look at. Sparse rows and sparse columns are both
 * normal in a hand-maintained workbook, so gaps are filled with "".
 */
function readSheet(xml, strings) {
  const rows = [];
  for (const rowMatch of xml.matchAll(/<row[^>]*\sr="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const number = Number(rowMatch[1]);
    const cells = [];
    for (const cell of rowMatch[2].matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cell[1];
      const inner = cell[2] ?? "";
      const ref = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1];
      if (!ref) continue;
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? "n";
      let value = "";
      if (type === "inlineStr") {
        for (const t of inner.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g))
          value += decodeEntities(t[1]);
      } else {
        const raw = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        if (raw !== undefined) value = type === "s" ? (strings[Number(raw)] ?? "") : raw;
      }
      cells[columnIndex(ref)] = value;
    }
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = "";
    rows.push({ number, cells });
  }
  return rows;
}

export function readWorkbook(path) {
  const files = unzip(path);
  const rels = files.get("xl/_rels/workbook.xml.rels")?.toString("utf8");
  const book = files.get("xl/workbook.xml")?.toString("utf8");
  if (!rels || !book) throw new Error(`${path} is not an .xlsx workbook`);
  const targets = new Map();
  for (const rel of rels.matchAll(/<Relationship([^>]*)\/>/g)) {
    const id = /Id="([^"]+)"/.exec(rel[1])?.[1];
    const target = /Target="([^"]+)"/.exec(rel[1])?.[1];
    if (id && target) targets.set(id, target.replace(/^\/?xl\//, ""));
  }
  const strings = files.has("xl/sharedStrings.xml")
    ? readSharedStrings(files.get("xl/sharedStrings.xml").toString("utf8"))
    : [];
  const sheets = new Map();
  for (const sheet of book.matchAll(/<sheet\s([^>]*)\/>/g)) {
    const name = decodeEntities(/name="([^"]*)"/.exec(sheet[1])?.[1] ?? "");
    const id = /r:id="([^"]+)"/.exec(sheet[1])?.[1];
    const target = id && targets.get(id);
    const xml = target && files.get(`xl/${target}`);
    if (xml) sheets.set(name, readSheet(xml.toString("utf8"), strings));
  }
  return {
    sheet(name) {
      const rows = sheets.get(name);
      if (!rows) {
        throw new Error(
          `The workbook has no tab named ${JSON.stringify(name)}.\n` +
            `  It has: ${[...sheets.keys()].map((n) => JSON.stringify(n)).join(", ")}`,
        );
      }
      return rows;
    },
  };
}

// ── Cell normalization ─────────────────────────────────────────────────────

const text = (row, i) => (row.cells[i] ?? "").trim();

/**
 * Collapse the whitespace inside a cell for comparison purposes.
 *
 * The workbook wraps headings with carriage returns and sometimes double-spaces
 * a word. Nothing downstream depends on that whitespace, and one heading is
 * spelled with a line break on the tab and without one in Column Description.
 */
const collapse = (s) => s.replace(/\s+/g, " ").trim();

/**
 * Form Field IDs are text on some rows ("1a.14.1") and numbers on others
 * ("9.3"), and a number arrives from the sheet at full binary precision —
 * 9.3 is stored as "9.3000000000000007". Round-tripping through a double gives
 * back the decimal somebody typed; anything that is not a number is left alone.
 */
export function normalizeFormFieldId(value) {
  const s = collapse(value ?? "");
  if (!s) return "";
  const n = Number(s);
  return Number.isFinite(n) && /^-?\d+(\.\d+)?$/.test(s) ? String(n) : s;
}

/**
 * Strip every whitespace character from an XPath cell.
 *
 * An XML element name cannot contain whitespace, so this cannot lose anything —
 * and one cell in the DU Map genuinely needs it: the
 * PROPERTY_VALUATION_DETAIL extension path is typed with a line break after
 * PROPERTY_VALUATIONS and two stray spaces inside the last segment. Without the
 * strip that path does not resolve against the schema and the build stops on a
 * typo rather than on a mapping.
 */
const normalizeXPath = (value) => (value ?? "").replace(/\s+/g, "");

// ── The workbook's own column list ─────────────────────────────────────────

/**
 * `Column Description` names every column of the three tabs this script reads,
 * in order. Checking the tab headings against it is what stops a reordered or
 * renamed column from being read as the column beside it — the failure mode
 * that produces a plausible-looking table of wrong values.
 *
 * Two headings differ between the two places by more than whitespace and case.
 * They are named here rather than tolerated by a looser comparison.
 */
export const COLUMN_NAME_ALIASES = {
  // Cardinality tab. The tab abbreviates the three products; Column Description
  // spells them out.
  "DU, Credit, Early Check Cardinality MIN:MAX": "DU, EC Cardinality MIN:MAX",
  // ArcRoles tab, endpoints section. Column Description pluralizes the first
  // column; the tab does not. Its second section spells it the tab's way, so
  // the alias folds both spellings onto one and neither section needs a
  // looser comparison than the other.
  ArcRole: "ArcRoles",
};

function columnNamesFor(columnDescription, tabHeading) {
  // The tab is a flat list. A cell reading "<something> Tab" opens a section —
  // sometimes in column A, sometimes in column B — and every row under it names
  // one column of that tab, in order, in column B. The per-section "Column
  // Name" label is the table's own heading, not a column.
  const names = [];
  let inSection = false;
  for (const row of columnDescription) {
    const a = collapse(text(row, 0));
    const b = collapse(text(row, 1));
    const heading = / Tab\*?$/.test(a) ? a : / Tab\*?$/.test(b) ? b : null;
    if (heading) {
      inSection = heading.replace(/\*$/, "") === tabHeading;
      continue;
    }
    if (!inSection || !b || b === "Column Name") continue;
    names.push(b);
  }
  if (!names.length) {
    throw new Error(`Column Description has no column list under ${JSON.stringify(tabHeading)}`);
  }
  return names;
}

/**
 * The two column lists the ArcRoles tab needs, rather than the one every other
 * tab needs.
 *
 * That tab is two tables stacked under one heading — "Establishing Endpoints in
 * the Relationship" describes each arc's ends, "Relationships Container"
 * describes the element that carries it — with their own header rows and no
 * column in common. `columnNamesFor` would return the two lists concatenated,
 * with the sub-headings mixed in as column names, and `assertColumns` would
 * then compare the second table's headings against the first table's.
 */
export function arcRoleColumnNamesFor(columnDescription, sections) {
  const wanted = new Set(Object.values(sections));
  const names = new Map([...wanted].map((s) => [s, []]));
  let current = null;
  let inTab = false;
  for (const row of columnDescription) {
    const a = collapse(text(row, 0));
    const b = collapse(text(row, 1));
    const heading = / Tab\*?$/.test(a) ? a : / Tab\*?$/.test(b) ? b : null;
    if (heading) {
      inTab = heading.replace(/\*$/, "") === `${TABS.arcRoles} Tab`;
      current = null;
      continue;
    }
    if (!inTab || !b || b === "Column Name") continue;
    // A sub-heading has no definition beside it; a column always does.
    if (wanted.has(b) && !text(row, 2)) {
      current = b;
      continue;
    }
    if (!current) {
      throw new Error(
        `Column Description lists ${JSON.stringify(b)} under ${JSON.stringify(TABS.arcRoles)} ` +
          "before naming a section.\n  The tab's sections were renamed. Re-read it.",
      );
    }
    names.get(current).push(b);
  }
  for (const [section, list] of names) {
    if (!list.length) {
      throw new Error(
        `Column Description has no column list under ${JSON.stringify(section)} on the ` +
          `${JSON.stringify(TABS.arcRoles)} tab.`,
      );
    }
  }
  return Object.fromEntries(
    Object.entries(sections).map(([key, section]) => [key, names.get(section)]),
  );
}

function assertColumns(tabName, headerRow, expected) {
  // Whitespace and case are not compared: the two places spell one heading
  // "MISMO v3.4Parent Container" and "MISMO v3.4 Parent Container", and another
  // "MISMO V3.4" against "MISMO v3.4". Anything that differs by more than that
  // is a real rename and belongs in COLUMN_NAME_ALIASES.
  const fold = (s) => (COLUMN_NAME_ALIASES[collapse(s)] ?? s).replace(/\s+/g, "").toLowerCase();
  for (let i = 0; i < expected.length; i++) {
    const actual = headerRow.cells[i] ?? "";
    if (fold(actual) !== fold(expected[i])) {
      throw new Error(
        `${tabName} column ${i + 1} is ${JSON.stringify(collapse(actual))}, but Column ` +
          `Description calls it ${JSON.stringify(expected[i])}.\n` +
          "  The columns moved. Re-read the tab before trusting anything this script emits.",
      );
    }
  }
}

// ── The XSD ────────────────────────────────────────────────────────────────

/**
 * Parse XML into a tag tree.
 *
 * The schemas carry no mixed content and no CDATA, so tags and attributes are
 * the whole of what matters and a scanner is enough. `xsd:documentation` text
 * is skipped rather than captured, which is why nothing here reads text nodes.
 */
function scanXml(source) {
  const root = { name: "#root", attrs: {}, children: [] };
  const stack = [root];
  const tag = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*"[^"]*")*)\s*(\/?)>|<!--[\s\S]*?-->/g;
  let m;
  while ((m = tag.exec(source))) {
    if (m[0].startsWith("<!--")) continue;
    const [, closing, name, attrText, selfClosing] = m;
    if (closing) {
      const open = stack.pop();
      if (!open || open.name !== name) throw new Error(`unbalanced </${name}> in schema`);
      continue;
    }
    const attrs = {};
    for (const a of attrText.matchAll(/([\w.:-]+)\s*=\s*"([^"]*)"/g)) attrs[a[1]] = a[2];
    const node = { name, attrs, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }
  if (stack.length !== 1) throw new Error("unbalanced schema document");
  return root;
}

/**
 * The child sequence of every complex type in the DU schema chain.
 *
 * MISMO writes every container as an `xsd:sequence`, sometimes wrapped in
 * `xsd:choice` for the REFERENCE-or-content pattern, and element order is the
 * one structural rule the schema actually enforces. So the order is read here,
 * in document order, and no code anywhere sorts it. The tempting
 * alphabetical-with-EXTENSION-last shortcut is wrong for DEAL, PARTY, ROLE,
 * EMPLOYER, COLLATERAL, CONTACT_POINT, LICENSE and DOCUMENT_SPECIFIC_DATA_SET
 * among others, all of which a DU submission leans on.
 *
 * Types are keyed by their namespace prefix — `PARTY`, `DU:LOAN_EXTENSION` —
 * because the MISMO model and the two Fannie extensions each declare types
 * named `LOAN_EXTENSION`, in three different namespaces, and the DU Map's
 * XPaths spell the prefix out.
 */
const CONTENT_MODEL_TAGS = new Set([
  "xsd:sequence",
  "xsd:choice",
  "xsd:all",
  "xsd:complexContent",
  "xsd:restriction",
  "xsd:extension",
]);

function parseSchemas() {
  const types = new Map();
  const groups = new Map();
  let anonymous = 0;

  const qualify = (prefix, name) => (prefix ? `${prefix}:${name}` : name);

  function contentOf(node, prefix, owner) {
    const out = [];
    const walk = (n) => {
      for (const child of n.children) {
        if (child.name === "xsd:element") {
          let type = child.attrs.type ?? null;
          if (!type) {
            const inline = child.children.find((c) => c.name === "xsd:complexType");
            if (inline) {
              // An element declared with its own anonymous complexType. It has
              // no name to key on, so it borrows its parent's.
              type = `${owner}/${child.attrs.name ?? `anonymous-${anonymous++}`}`;
              types.set(type, contentOf(inline, prefix, type));
            }
          }
          out.push({ name: child.attrs.name, type, prefix });
        } else if (child.name === "xsd:group" && child.attrs.ref) {
          out.push({ groupRef: child.attrs.ref });
        } else if (CONTENT_MODEL_TAGS.has(child.name)) {
          walk(child);
        }
      }
    };
    walk(node);
    return out;
  }

  // Order matters: the DU wrapper redefines fourteen MISMO extension types, and
  // a redefinition replaces the type it names. Reading MISMO first and the
  // wrapper second is what makes the replacement happen.
  const order = [
    ["", XSD_FILES.mismo],
    ["", XSD_FILES.wrapper],
    ["DU", XSD_FILES.duExtension],
    ["ULAD", XSD_FILES.uladExtension],
  ];
  for (const [prefix, path] of order) {
    const schema = scanXml(readFileSync(path, "utf8")).children.find(
      (c) => c.name === "xsd:schema",
    );
    if (!schema) throw new Error(`${path} has no xsd:schema element`);
    const visit = (container, redefining) => {
      for (const child of container.children) {
        if (child.name === "xsd:complexType" && child.attrs.name) {
          const key = qualify(prefix, child.attrs.name);
          if (redefining && !types.has(key)) {
            throw new Error(
              `${path} redefines ${key}, which no earlier schema declares. ` +
                "The schema chain is assembled in the wrong order.",
            );
          }
          types.set(key, contentOf(child, prefix, key));
        } else if (child.name === "xsd:group" && child.attrs.name) {
          const key = qualify(prefix, child.attrs.name);
          groups.set(key, contentOf(child, prefix, key));
        } else if (child.name === "xsd:redefine") {
          visit(child, true);
        }
      }
    };
    visit(schema, false);
  }

  function childrenOf(typeName) {
    const raw = types.get(typeName);
    if (!raw) return null;
    const out = [];
    for (const entry of raw) {
      if (!entry.groupRef) {
        out.push(entry);
        continue;
      }
      const group = groups.get(entry.groupRef);
      if (!group) throw new Error(`${typeName} references undeclared group ${entry.groupRef}`);
      for (const member of group) out.push(member);
    }
    return out;
  }

  return { childrenOf };
}

/**
 * Walk every XPath the spec names, from MESSAGE down, and record the child
 * order of each type the walk visits.
 *
 * The walk checks the schema in the other direction too: a segment the parent
 * type does not declare stops the build. That is the failure an emitter would
 * otherwise discover as a Fannie rejection.
 */
export function buildOrderTable(schema, xpaths) {
  const order = new Map();
  const typeForPath = new Map();
  for (const xpath of xpaths) {
    const segments = xpath.split("/");
    if (segments[0] !== "MESSAGE") {
      throw new Error(`XPath does not start at MESSAGE: ${JSON.stringify(xpath)}`);
    }
    let type = "MESSAGE";
    let seen = "MESSAGE";
    for (const segment of segments.slice(1)) {
      const children = schema.childrenOf(type);
      if (!children) throw new Error(`${seen}: the schema declares no type ${type}`);
      order.set(
        type,
        children.map((c) => (c.prefix ? `${c.prefix}:${c.name}` : c.name)),
      );
      const colon = segment.indexOf(":");
      const prefix = colon === -1 ? "" : segment.slice(0, colon);
      const local = colon === -1 ? segment : segment.slice(colon + 1);
      const hit = children.find((c) => c.name === local && (c.prefix ?? "") === prefix);
      if (!hit) {
        throw new Error(
          `${type} does not declare a child named ${JSON.stringify(segment)} ` +
            `(reached by ${seen}).\n  It declares: ${order.get(type).join(", ")}`,
        );
      }
      if (!hit.type) throw new Error(`${type}/${segment} has no type in the schema`);
      type = hit.type;
      seen = `${seen}/${segment}`;
    }
    const leaf = schema.childrenOf(type);
    if (leaf)
      order.set(
        type,
        leaf.map((c) => (c.prefix ? `${c.prefix}:${c.name}` : c.name)),
      );
    typeForPath.set(xpath, type);
  }
  return { order, typeForPath };
}

// ── Enumerations ───────────────────────────────────────────────────────────

/**
 * Every `Du*` enum in `enums.ts`, and the DU data point it draws its members
 * from.
 *
 * This table is what makes the enum CHECK diff runnable at all: a `du_*`
 * column's comment names the DATA POINT, and this is what says which enum's
 * members that column's CHECK is diffed against. No enum here is
 * named after its data point, several of them are named nothing like it, and
 * one has no data point behind it — so "look the enum name up in the DU
 * Enumerations tab" finds nothing, and the rule written to catch a member
 * nobody can source would itself be unrunnable.
 *
 * `formFields` are the DU MAP's form field ids, which is not always the id the
 * DU Enumerations tab files the same field under; TAB_DISAGREEMENTS below
 * carries the four places they differ. An empty `formFields` means every row
 * for that data point, whatever it is filed under.
 *
 * `local: true` is the other half of the honesty: an enum that is ours, with no
 * DU data point behind it, says so, so that "unmapped by mistake" and
 * "deliberately ours" are different states rather than the same silence.
 *
 * An enum whose column does not exist yet diffs vacuously: it passes because
 * there is nothing to check, not because something was checked.
 */
export const DU_DATA_POINT_FOR_ENUM = {
  // declarations and residences
  DuYesNo: {
    // One enum, two data points, and the generator asserts they agree. They are
    // the two declaration questions DU asks as Yes/No.
    dataPoints: [
      { name: "IntentToOccupyType", formFields: ["5a.1"] },
      { name: "HomeownerPastThreeYearsType", formFields: ["5a.1.1"] },
    ],
  },
  DuPriorPropertyTitle: {
    dataPoints: [{ name: "PriorPropertyTitleType", formFields: ["5a.1.3"] }],
  },
  DuBankruptcyChapter: { dataPoints: [{ name: "BankruptcyChapterType", formFields: ["5b.8.1"] }] },
  DuResidencyBasis: {
    dataPoints: [{ name: "BorrowerResidencyBasisType", formFields: ["1a.14.1", "1a.16.1"] }],
  },
  DuResidencyType: {
    // Current at 1a.13 and Prior at 1a.15: the two form fields carry one member
    // each, so both are declared and the enum is their union.
    dataPoints: [{ name: "BorrowerResidencyType", formFields: ["1a.13", "1a.15"] }],
  },

  // assets, liabilities, expenses, owned property
  DuAssetType: { dataPoints: [{ name: "AssetType", formFields: [] }] },
  DuAssetTypeOtherDescription: {
    // `String (DU Enumerated)` in the Map, and an enumeration in fact: two
    // supported values. Modeling it as free text puts a borrower's "Coin
    // collection" through every check we have and into a DU rejection.
    dataPoints: [{ name: "AssetTypeOtherDescription", formFields: ["2b.1"] }],
  },
  DuLiabilityType: {
    // 2c.1 is what the borrower declares, 3a.11 the mortgages against owned
    // property. One column holds both, so the enum is the union.
    dataPoints: [{ name: "LiabilityType", formFields: ["2c.1", "3a.11"] }],
  },
  DuLiabilityMortgageType: {
    dataPoints: [{ name: "MortgageType", formFields: ["3a.14"] }],
  },
  DuExpenseType: { dataPoints: [{ name: "ExpenseType", formFields: ["2d.1"] }] },
  DuOwnedPropertyDisposition: {
    dataPoints: [{ name: "OwnedPropertyDispositionStatusType", formFields: ["3a.4"] }],
  },
  DuPropertyUsage: {
    // Two data points, one member set, and the generator asserts they agree.
    // 5a.1.2 is the one a column carries today — how a borrower used the home
    // they owned before — so declaring only the current-usage point would leave
    // that column's members unchecked and the diff green for the wrong reason.
    dataPoints: [
      { name: "PropertyCurrentUsageType", formFields: [] },
      { name: "PriorPropertyUsageType", formFields: ["5a.1.2"] },
    ],
  },
  DuIntendedPropertyUsage: {
    // Not the same enum as DuPropertyUsage and not mergeable with it: 3a.5
    // carries Other and the current-usage list does not.
    dataPoints: [{ name: "PropertyUsageType", formFields: ["3a.5"] }],
  },
  DuPropertyUsageOtherDescription: {
    dataPoints: [{ name: "PropertyUsageTypeOtherDescription", formFields: [] }],
  },
  DuFundsSourceType: { dataPoints: [{ name: "FundsSourceType", formFields: ["4d.3"] }] },
  DuAssetKind: {
    // Ours. A discriminator over the four kinds of asset row we store, with no
    // DU data point behind it and nothing to diff against.
    local: true,
  },

  // vesting and the non-borrower parties
  DuPropertyOwnerStatus: {
    dataPoints: [{ name: "PropertyOwnerStatusType", formFields: ["L2.1", "L2.2"] }],
  },
  DuVestingType: { dataPoints: [{ name: "RelationshipVestingType", formFields: ["L2.4"] }] },
  DuLicenseAuthorityLevel: {
    dataPoints: [{ name: "LicenseAuthorityLevelType", formFields: ["9.3", "9.4", "9.6", "9.7"] }],
  },
  DuDealPartyRole: {
    // Every role a DEAL party can hold except Borrower, which has its own
    // container and its own table and is never one of these.
    dataPoints: [{ name: "PartyRoleType", formFields: [] }],
    exclude: ["Borrower"],
  },

  // DU:UNDERWRITING_VERIFICATION
  DuVerificationReportType: {
    // The only row that NAMES a blank form field rather than leaving the list
    // empty to mean "any". The Map files this data point as "Not On Form", and
    // asserting the blank is the point: a blank that arrives by accident on
    // some other row is exactly what this key exists to catch.
    dataPoints: [{ name: "DU:VerificationReportType", formFields: [""] }],
  },
};

/**
 * The four places the DU Map and the DU Enumerations tab file the same field
 * under different form field ids.
 *
 * A strict join on the Map's id finds nothing for these, so the generator has
 * to be told where each one actually lives — and it asserts that both tabs give
 * the field the same NAME, which is what makes the reconciliation a fact rather
 * than a guess. Any fifth disagreement stops the build.
 */
export const TAB_DISAGREEMENTS = [
  {
    // "Type", the mortgage type of a liability against owned property.
    dataPoint: "MortgageType",
    mapFormField: "3a.14",
    enumerationFormField: "3a.12",
  },
  {
    // "State License ID#" for the loan origination company. The Map renumbered
    // section 9; the Enumerations tab still files it under section 8.
    dataPoint: "LicenseAuthorityLevelType",
    mapFormField: "9.4",
    enumerationFormField: "8.4",
  },
  {
    // "State License ID#" for the individual loan originator. Same renumbering.
    dataPoint: "LicenseAuthorityLevelType",
    mapFormField: "9.7",
    enumerationFormField: "8.7",
  },
  {
    // "Loan Originator Organization Name". Same renumbering again.
    dataPoint: "PartyRoleType",
    mapFormField: "9.1",
    enumerationFormField: "8.1",
  },
];

/**
 * The four enumeration cells the DU Enumerations tab leaves blank.
 *
 * Read verbatim they yield `IntentToOccupyType ∈ {No}` — a DU-Required type
 * that cannot express "Yes, I will occupy this property" — and
 * `HomeownerPastThreeYearsType ∈ {Yes}`. Both are rows 205-210 of the tab, and
 * the EDI Code Values column beside them says which value each blank stands
 * for: the two `U = Unknown` rows are blank because DU supports no Unknown, and
 * the other two are blank by mistake.
 *
 * They are named here, one row at a time, rather than patched by a default.
 * Every entry must match exactly one blank cell and every blank cell must match
 * an entry, so a corrected workbook stops the build and this list gets shorter.
 */
export const BLANK_ENUMERATION_CELLS = [
  { dataPoint: "IntentToOccupyType", ediCode: "Y = Yes", value: "Yes" },
  { dataPoint: "IntentToOccupyType", ediCode: "U = Unknown", value: null },
  { dataPoint: "HomeownerPastThreeYearsType", ediCode: "N = No", value: "No" },
  { dataPoint: "HomeownerPastThreeYearsType", ediCode: "U = Unknown", value: null },
];

/**
 * Values a data point carries somewhere we do not read it from.
 *
 * Narrowing an enum by picking one form field out of several is exactly the
 * kind of edit that looks harmless and loses a value, so every value left
 * behind is named. An unnamed one stops the build.
 */
export const VALUES_NOT_IN_SCOPE = [
  {
    // The subject loan's own mortgage type, at L3.1. It lives on TERMS_OF_LOAN
    // and is a different column from a liability's.
    enumName: "DuLiabilityMortgageType",
    values: ["Conventional", "USDARuralDevelopment", "VA"],
  },
  {
    // ORIGINATION_FUND carries a thirteenth source, on rows whose Form Field ID
    // cell is blank. A gift or grant on an asset cannot come from the seller.
    enumName: "DuFundsSourceType",
    values: ["PropertySeller"],
  },
];

/** Twenty-three values carry a `*` or `**` footnote marker meaning "new for DU". */
const FOOTNOTE_MARKER = /\*{1,2}$/;

/**
 * Derive the members of every `Du*` enum from the DU Enumerations tab.
 *
 * Spellings are never corrected. `AccessoryUnitIincome`, with the double
 * lowercase i, is canonical in MISMOEnumeratedTypesB324.xsd itself, and
 * "fixing" it produces a file DU rejects.
 */
export function deriveEnumerations(enumerationRows, options = {}) {
  const table = options.table ?? DU_DATA_POINT_FOR_ENUM;
  const disagreements = options.disagreements ?? TAB_DISAGREEMENTS;
  const blanks = options.blanks ?? BLANK_ENUMERATION_CELLS;
  const notInScope = options.notInScope ?? VALUES_NOT_IN_SCOPE;

  // Resolve every blank cell before anything reads a value.
  const unusedBlanks = new Set(blanks.map((_, i) => i));
  const rows = enumerationRows.map((row) => {
    const raw = row.value;
    if (raw !== "") return { ...row, value: raw.replace(FOOTNOTE_MARKER, "") };
    const index = blanks.findIndex(
      (b, i) => unusedBlanks.has(i) && b.dataPoint === row.dataPoint && b.ediCode === row.ediCode,
    );
    if (index === -1) {
      throw new Error(
        `Blank enumeration cell for ${row.dataPoint} at row ${row.rowNumber} of the ` +
          `${TABS.enumerations} tab (EDI code ${JSON.stringify(row.ediCode)}).\n` +
          "  Add it to BLANK_ENUMERATION_CELLS with the value it stands for, or null if DU\n" +
          "  supports no value there.",
      );
    }
    unusedBlanks.delete(index);
    return { ...row, value: blanks[index].value };
  });
  if (unusedBlanks.size) {
    const stale = [...unusedBlanks].map((i) => `${blanks[i].dataPoint} / ${blanks[i].ediCode}`);
    throw new Error(
      `BLANK_ENUMERATION_CELLS names cells that are no longer blank: ${stale.join(", ")}.\n` +
        "  The workbook was corrected. Delete those entries.",
    );
  }

  const byDataPoint = new Map();
  for (const row of rows) {
    if (!byDataPoint.has(row.dataPoint)) byDataPoint.set(row.dataPoint, []);
    byDataPoint.get(row.dataPoint).push(row);
  }

  const reconcile = (dataPoint, formField) => {
    const hit = disagreements.find(
      (d) => d.dataPoint === dataPoint && d.mapFormField === formField,
    );
    return hit ? hit.enumerationFormField : formField;
  };

  const enumerations = {};
  const local = [];
  for (const [enumName, spec] of Object.entries(table)) {
    if (spec.local) {
      local.push(enumName);
      continue;
    }
    const perDataPoint = [];
    for (const dataPoint of spec.dataPoints) {
      const all = byDataPoint.get(dataPoint.name);
      if (!all) {
        throw new Error(
          `${enumName} maps to data point ${JSON.stringify(dataPoint.name)}, which the ` +
            `${TABS.enumerations} tab does not carry.`,
        );
      }
      const wanted = dataPoint.formFields.map((f) => reconcile(dataPoint.name, f));
      const values = [];
      for (const row of all) {
        if (wanted.length && !wanted.includes(row.formFieldId)) continue;
        if (row.value === null) continue;
        if (spec.exclude?.includes(row.value)) continue;
        if (!values.includes(row.value)) values.push(row.value);
      }
      if (!values.length) {
        throw new Error(
          `${enumName} derives no members from ${dataPoint.name}` +
            (wanted.length ? ` at form field(s) ${wanted.join(", ")}` : "") +
            ".\n  Check DU_DATA_POINT_FOR_ENUM against the tab.",
        );
      }
      for (const formField of wanted) {
        if (!all.some((r) => r.formFieldId === formField)) {
          throw new Error(
            `${enumName} names form field ${JSON.stringify(formField)} for ` +
              `${dataPoint.name}, which the ${TABS.enumerations} tab does not file it under.\n` +
              "  Add a TAB_DISAGREEMENTS entry naming where it actually lives.",
          );
        }
      }
      perDataPoint.push({ name: dataPoint.name, values, wanted });
    }

    const [first, ...rest] = perDataPoint;
    for (const other of rest) {
      if (other.values.join(" ") !== first.values.join(" ")) {
        throw new Error(
          `${enumName} draws on ${first.name} and ${other.name}, which do not agree:\n` +
            `    ${first.name}: ${first.values.join(", ")}\n` +
            `    ${other.name}: ${other.values.join(", ")}\n` +
            "  Two data points behind one enum have to carry the same members.",
        );
      }
    }
    enumerations[enumName] = first.values;

    // Anything the data point carries that this enum does not take must be
    // named, so that narrowing an enum is never silent.
    const declared = new Set(first.values);
    const excluded = new Set(spec.exclude ?? []);
    const spare = [];
    for (const dataPoint of spec.dataPoints) {
      for (const row of byDataPoint.get(dataPoint.name)) {
        if (row.value === null || declared.has(row.value) || excluded.has(row.value)) continue;
        if (!spare.includes(row.value)) spare.push(row.value);
      }
    }
    const named = notInScope.find((n) => n.enumName === enumName)?.values ?? [];
    const unnamed = spare.filter((v) => !named.includes(v));
    if (unnamed.length) {
      throw new Error(
        `${enumName} leaves ${unnamed.join(", ")} behind: the data point carries them at a ` +
          "form field this enum does not read.\n" +
          "  Add them to VALUES_NOT_IN_SCOPE with the reason, or widen the enum.",
      );
    }
    const missing = named.filter((v) => !spare.includes(v));
    if (missing.length) {
      throw new Error(
        `VALUES_NOT_IN_SCOPE claims ${enumName} leaves ${missing.join(", ")} behind, but the ` +
          "tab no longer carries them.",
      );
    }
  }
  return { enumerations, local };
}

/**
 * The three URLA sections `AssetType` is filed under, and the CHECK that gives
 * each one its values.
 *
 * `du_assets.kind` says which section a row belongs to and the emitter keys
 * conditionality on it, so a row whose kind and type disagree is emitted under
 * the wrong rules — `kind = OTHER_ASSET` with `asset_type = 'CheckingAccount'`
 * writes a checking account with no holder name and no account identifier, both
 * of which DU requires once an amount exists. The CHECKs are what stop it, and
 * this table is what stops the CHECKs from being three hand-typed lists.
 */
export const ASSET_TYPE_SECTIONS = [
  { kind: "DEPOSIT_ACCOUNT", formField: "2a.1", constraint: "du_assets_deposit_account_shape" },
  { kind: "OTHER_ASSET", formField: "2b.1", constraint: "du_assets_other_asset_shape" },
  { kind: "GIFT_OR_GRANT", formField: "4d.1", constraint: "du_assets_gift_or_grant_shape" },
];

/**
 * `AssetType`, split by the Form Field ID the DU Enumerations tab files each
 * member under.
 *
 * The union of these is `DuAssetType`, which is what `du_assets.asset_type`
 * holds; the split is which of them each `kind` may take. Deriving it here
 * rather than reading the three lists off the migration is the point: a spec
 * revision that moves a value from 2b.1 to 2a.1 changes this table, and the
 * check below then fails rather than leaving a CHECK quietly widened.
 */
export function deriveAssetTypeSections(enumerationRows, options = {}) {
  const sections = options.sections ?? ASSET_TYPE_SECTIONS;
  const wanted = new Set(sections.map((s) => s.formField));
  const byFormField = new Map(sections.map((s) => [s.formField, []]));
  const strays = [];

  for (const row of enumerationRows) {
    if (row.dataPoint !== "AssetType") continue;
    const value = row.value.replace(FOOTNOTE_MARKER, "");
    if (!value) {
      throw new Error(
        `AssetType has a blank enumeration cell at row ${row.rowNumber} of the ` +
          `${TABS.enumerations} tab. There is no value to give a CHECK.`,
      );
    }
    if (!wanted.has(row.formFieldId)) {
      if (!strays.includes(row.formFieldId)) strays.push(row.formFieldId);
      continue;
    }
    const values = byFormField.get(row.formFieldId);
    if (!values.includes(value)) values.push(value);
  }

  if (strays.length) {
    throw new Error(
      `The ${TABS.enumerations} tab files AssetType under ${strays.join(", ")} as well as ` +
        `${sections.map((s) => s.formField).join(", ")}.\n` +
        "  A fourth section is a fourth kind of asset row, or a value with no CHECK to admit\n" +
        "  it. Add it to ASSET_TYPE_SECTIONS with the kind and the constraint that carries it.",
    );
  }
  for (const [formField, values] of byFormField) {
    if (!values.length) {
      throw new Error(
        `AssetType has no members at form field ${formField}, which ASSET_TYPE_SECTIONS names.`,
      );
    }
  }
  return Object.fromEntries(byFormField);
}

/** Read the partition back out of the generated enums.ts. */
export function parseGeneratedAssetTypeSections(source) {
  const body = /export const DU_ASSET_TYPES_BY_SECTION[^=]*=\s*\{([\s\S]*?)\n\} as const;/.exec(
    source,
  );
  if (!body) {
    throw new Error(
      `${OUT_REL}/enums.ts does not carry DU_ASSET_TYPES_BY_SECTION.\n` +
        "  Run: npm run du:build",
    );
  }
  const found = {};
  for (const entry of body[1].matchAll(/^ {2}"([^"]+)":\s*\[([^\]]*)\],$/gm)) {
    found[entry[1]] = [...entry[2].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  }
  return found;
}

/**
 * The AssetType values each per-kind CHECK in the migration admits.
 *
 * A regex over SQL is safe here for the same reason it is safe over the
 * generated file: the shape is asserted rather than assumed, and a constraint
 * this cannot find is an error instead of an empty list. The constraint name
 * may be bare or double-quoted, and the CHECK runs to its balancing
 * parenthesis, with `--` comments dropped first so a parenthesis in prose
 * cannot close it early.
 */
export function assetTypeListsInMigration(sql, options = {}) {
  const sections = options.sections ?? ASSET_TYPE_SECTIONS;
  const path = options.path ?? DU_GRAPH_MIGRATION_GLOB;
  const source = sql.replace(/--[^\n]*/g, "");
  const found = {};
  for (const section of sections) {
    const open = new RegExp(`ADD CONSTRAINT "?${section.constraint}"? CHECK \\(`).exec(source);
    if (!open) {
      throw new Error(
        `${path} has no CHECK named ${section.constraint}.\n` +
          "  The per-kind shapes are where the AssetType partition is enforced; a missing one\n" +
          "  is a kind that may hold any type at all.",
      );
    }
    const start = open.index + open[0].length;
    let depth = 1;
    let end = start;
    while (end < source.length && depth > 0) {
      if (source[end] === "(") depth += 1;
      else if (source[end] === ")") depth -= 1;
      end += 1;
    }
    if (depth !== 0) {
      throw new Error(`${section.constraint} in ${path} never closes its CHECK.`);
    }
    const list = /asset_type IN \(([\s\S]*?)\)/.exec(source.slice(start, end - 1));
    if (!list) {
      throw new Error(
        `${section.constraint} does not name the AssetType values it admits.\n` +
          "  A shape CHECK that constrains only the columns lets the discriminator lie.",
      );
    }
    found[section.constraint] = [...list[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
  }
  return found;
}

/**
 * Diff the migration's three value lists against the partition the spec draws,
 * and account for every member of the enum.
 */
export function diffAssetTypeChecks(sections, migrationLists, assetTypeMembers, options = {}) {
  const table = options.sections ?? ASSET_TYPE_SECTIONS;
  const problems = [];
  const claimed = new Set();
  for (const section of table) {
    const expected = sections[section.formField] ?? [];
    const actual = migrationLists[section.constraint] ?? [];
    for (const value of actual) {
      claimed.add(value);
      if (!expected.includes(value)) {
        problems.push(
          `${section.constraint} admits ${value}, which the DU Enumerations tab does not file ` +
            `under ${section.formField}.`,
        );
      }
    }
    for (const value of expected) {
      if (!actual.includes(value)) {
        problems.push(
          `${section.constraint} is missing ${value}, which the tab files under ` +
            `${section.formField}; no ${section.kind} row could hold it.`,
        );
      }
    }
  }
  for (const member of assetTypeMembers) {
    if (!claimed.has(member)) {
      problems.push(
        `DuAssetType.${member} is admitted by no kind's CHECK, so no row can carry it.`,
      );
    }
  }
  return problems;
}

// ── Formats, from the DU Map ───────────────────────────────────────────────

/**
 * `DU Data Point Format` prose → a structured format.
 *
 * The widths are NOT uniform across destinations for the same data point:
 * AddressLineText is String 50 under the subject property's ADDRESS and
 * String 35 under an owned property's, and the same split runs between a
 * RESIDENCE address and an EMPLOYER address. So the table this feeds is keyed
 * on the XPath, and nothing anywhere compares two renderings for equality —
 * equality is the wrong invariant when the two destinations have different
 * widths.
 */
export function parseFormat(prose) {
  const s = collapse(prose);
  if (s === "Boolean") return { kind: "boolean" };
  if (s === "Enumerated") return { kind: "enumerated" };
  if (s === "String (DU Enumerated)") return { kind: "string_enumerated" };
  if (s === "CCYY") return { kind: "year" };
  if (s === "CCYY-MM-DD") return { kind: "date" };
  if (s === "CCYY-MM-DDThh:mm:ssZ") return { kind: "datetime" };

  let m = /^String (\d+)$/.exec(s);
  if (m) return { kind: "string", maxLength: Number(m[1]) };
  m = /^Numeric (\d+)$/.exec(s);
  if (m) return { kind: "numeric", digits: Number(m[1]) };
  m = /^Code (\d+)$/.exec(s);
  if (m) return { kind: "code", digits: Number(m[1]) };
  m = /^Amount (\d+)\.(\d+)$/.exec(s);
  if (m) return { kind: "amount", digits: Number(m[1]), decimals: Number(m[2]) };
  m = /^Percent (\d+)\.(\d+)$/.exec(s);
  if (m) return { kind: "percent", digits: Number(m[1]), decimals: Number(m[2]) };

  throw new Error(
    `Unrecognized DU Data Point Format: ${JSON.stringify(prose)}\n` +
      "  Add it to parseFormat in tools/build-du.mjs. Do not guess a width.",
  );
}

/**
 * Rows that name a data point and leave the format cell empty.
 *
 * There is exactly one, and the sheet simply does not say what width it is. It
 * is recorded with no format rather than given an invented one — a guessed
 * width is a value that passes every check here and is rejected by DU.
 */
export const BLANK_FORMAT_ROWS = [
  {
    xpath: "MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL/LOANS/LOAN/PURCHASE_CREDITS/PURCHASE_CREDIT",
    dataPoint: "PurchaseCreditAmount",
  },
];

// ── Conditionality, from the DU Map ────────────────────────────────────────

/**
 * `Desktop Underwriter (DU)` column → what the data point owes us.
 */
const REQUIREMENT = {
  R: "required",
  O: "optional",
  C: "conditional",
  "N/A": "not_applicable",
};

/**
 * The conditionality statements, as a grammar rather than a lookup table.
 *
 * There are 214 conditional data points writing 85 distinct statements, and
 * they are near enough to an expression language that parsing them beats
 * hand-keying 85 phrases — a hand-keyed table drifts the moment Fannie adds the
 * eighty-sixth. Every token the lexer does not know stops the build, which is
 * the same promise a lookup table makes.
 *
 * The sheet is typed by hand, so two things are normalized before lexing, and
 * neither can change a value: curly quotes become straight ones, and a trailing
 * full stop is dropped. Keywords are matched case-insensitively because one
 * statement writes `and` in lower case.
 */
export function parseConditionality(statement) {
  const named = UNPARSEABLE_STATEMENTS.find((u) => u.statement === collapse(statement));
  if (named) return named.condition;

  const source = collapse(statement).replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\.$/, "");
  if (!/^IF\b/i.test(source)) {
    throw new Error(
      `Conditionality statement does not start with IF: ${JSON.stringify(statement)}`,
    );
  }

  const tokens = [];
  const lexer = /\s*(\(|\)|<>|<=|>=|=|<|>|"[^"]*"|-?\d+(?:\.\d+)?|[A-Za-z_][\w.:]*)/y;
  lexer.lastIndex = 2;
  while (lexer.lastIndex < source.length) {
    const at = lexer.lastIndex;
    const m = lexer.exec(source);
    if (!m) {
      throw new Error(
        `Unrecognized conditionality phrase at ${JSON.stringify(source.slice(at).trim())}\n` +
          `  in ${JSON.stringify(statement)}\n` +
          "  Teach the grammar in tools/build-du.mjs, or name the statement in\n" +
          "  UNPARSEABLE_STATEMENTS with the condition somebody read it as.",
      );
    }
    tokens.push(m[1]);
  }

  let at = 0;
  const peek = () => tokens[at];
  const eat = (t) => {
    if ((peek() ?? "").toLowerCase() !== t.toLowerCase()) return false;
    at++;
    return true;
  };

  function parseOr() {
    const terms = [parseAnd()];
    while (eat("OR")) terms.push(parseAnd());
    return terms.length === 1 ? terms[0] : { kind: "or", terms };
  }
  function parseAnd() {
    const terms = [parsePrimary()];
    while (eat("AND")) terms.push(parsePrimary());
    return terms.length === 1 ? terms[0] : { kind: "and", terms };
  }
  function parsePrimary() {
    if (eat("(")) {
      const inner = parseOr();
      if (!eat(")")) throw new Error(`Unbalanced parenthesis in ${JSON.stringify(statement)}`);
      return inner;
    }
    const token = peek();
    if (token === undefined) throw new Error(`Statement ends early: ${JSON.stringify(statement)}`);
    // A bare `exists` is the data point on this row.
    if (eat("exists")) return { kind: "self_exists" };
    if (!/^[A-Za-z_][\w.:]*$/.test(token)) {
      throw new Error(
        `Expected a data point name, found ${JSON.stringify(token)} in ` +
          JSON.stringify(statement),
      );
    }
    at++;
    if (eat("exists")) return { kind: "exists", dataPoint: token };
    if (eat("does")) {
      if (!eat("not") || !eat("exist")) {
        throw new Error(`Expected "does not exist" in ${JSON.stringify(statement)}`);
      }
      return { kind: "absent", dataPoint: token };
    }
    for (const operator of ["<>", "<=", ">=", "=", "<", ">"]) {
      if (!eat(operator)) continue;
      const literal = peek();
      if (literal === undefined)
        throw new Error(`Statement ends early: ${JSON.stringify(statement)}`);
      at++;
      const value = literal.startsWith('"') ? literal.slice(1, -1) : Number(literal);
      if (operator !== "=") return { kind: "compare", dataPoint: token, operator, value };
      // `X = "A" OR "B"` is one comparison against a set, not two expressions.
      const values = [value];
      while (peek() === "OR" && (tokens[at + 1] ?? "").startsWith('"')) {
        at++;
        values.push(tokens[at++].slice(1, -1));
      }
      return values.length === 1
        ? { kind: "compare", dataPoint: token, operator: "=", value }
        : { kind: "in", dataPoint: token, values };
    }
    // A bare data point inside an OR chain: `A OR B exists` means both.
    return { kind: "exists", dataPoint: token };
  }

  const condition = parseOr();
  if (at !== tokens.length) {
    throw new Error(
      `Unrecognized conditionality phrase at ${JSON.stringify(tokens.slice(at).join(" "))}\n` +
        `  in ${JSON.stringify(statement)}`,
    );
  }
  return condition;
}

/**
 * The statements the grammar cannot take, and what a human read them as.
 *
 * There is one. `FinancedUnitCount > 1 but <5` is prose, not an expression, and
 * the range it means is written out here rather than bent into the lexer, where
 * it would teach the parser to accept "but" everywhere.
 */
export const UNPARSEABLE_STATEMENTS = [
  {
    statement:
      'IF LoanPurposeType = "Purchase" AND (PropertyUsageType = "Investment" OR ' +
      '(PropertyUsageType = "PrimaryResidence" AND FinancedUnitCount > 1 but <5))',
    condition: {
      kind: "and",
      terms: [
        { kind: "compare", dataPoint: "LoanPurposeType", operator: "=", value: "Purchase" },
        {
          kind: "or",
          terms: [
            { kind: "compare", dataPoint: "PropertyUsageType", operator: "=", value: "Investment" },
            {
              kind: "and",
              terms: [
                {
                  kind: "compare",
                  dataPoint: "PropertyUsageType",
                  operator: "=",
                  value: "PrimaryResidence",
                },
                { kind: "compare", dataPoint: "FinancedUnitCount", operator: ">", value: 1 },
                { kind: "compare", dataPoint: "FinancedUnitCount", operator: "<", value: 5 },
              ],
            },
          ],
        },
      ],
    },
  },
];

// ── Cardinality ────────────────────────────────────────────────────────────

export function parseCardinality(cell, xpath) {
  const s = collapse(cell);
  if (s === "N/A") return null;
  const m = /^(\d+):(\d+)$/.exec(s);
  if (!m) {
    throw new Error(
      `Unrecognized cardinality ${JSON.stringify(cell)} at ${xpath}. ` + "Expected MIN:MAX or N/A.",
    );
  }
  const [min, max] = [Number(m[1]), Number(m[2])];
  if (min > max) throw new Error(`Cardinality ${s} at ${xpath} has a minimum above its maximum`);
  return { min, max };
}

// ── Arc roles ──────────────────────────────────────────────────────────────

/**
 * The two sections of the ArcRoles tab, by the names Column Description gives
 * them.
 *
 * They describe the same eleven arcs twice, from two directions: the first
 * says where each end of an arc lives in the document, the second says what the
 * `RELATIONSHIP` element carrying it looks like. Reading only one of them is
 * how the disagreements below stay invisible.
 */
export const ARCROLE_SECTIONS = {
  endpoints: "Establishing Endpoints in the Relationship",
  relationships: "Relationships Container",
};

/**
 * The URN every DU arcrole is built on.
 *
 * Four of the eleven blocks on the tab type the namespace in one cell and the
 * arc's name in the next, and the other seven type the whole URI in one cell
 * with the name repeated beside it. Both spellings are checked against this
 * constant, so the emitted URI is assembled from one string rather than copied
 * from whichever cell happened to be complete.
 */
const ARCROLE_NAMESPACE = "urn:fdc:mismo.org:2009:residential";

/**
 * The verb phrases the tab uses, which are two.
 *
 * Exhaustive on purpose, like every other mapping here: an arc named with a
 * third verb cannot be split into its two endpoint terms by this script, and a
 * split that guesses would file the wrong element at one end of a graph nobody
 * can validate afterwards.
 */
export const ARCROLE_VERB_PHRASES = ["IsAssociatedWith", "SharesJointCreditReportWith"];

/** The only value the Relationships Container section puts in its Attribute column. */
const ARCROLE_ATTRIBUTES = ["Sequence Number"];

/**
 * The two ends where the tab contradicts itself about which element the arc
 * touches.
 *
 * Each end is named four times over the two sections — by the endpoint XPath,
 * by the Source/Target column, by the `from`/`to` row, and by the arcrole URI
 * itself — and at these two ends those four do not agree. Nothing here picks a
 * winner: the generated table carries all four names and a `disputed` flag, and
 * whoever writes the emitter decides with Fannie Mae rather than with a
 * coin-toss made in this script.
 *
 * The list is declared so that a third disagreement stops the build and a
 * healed one does too. A tab that quietly grows one would otherwise land as a
 * flag nobody reads.
 */
export const ARCROLE_ENDPOINT_DISAGREEMENTS = [
  // The XPath and the Target column say OWNED_PROPERTY_DETAIL; the `to` row and
  // the arcrole's own name say ASSET. OWNED_PROPERTY_DETAIL is a grandchild of
  // ASSET, so these are not synonyms and the arc lands on one or the other.
  { arcrole: "UNDERWRITING_VERIFICATION_IsAssociatedWith_ASSET", end: "to" },
  // The XPath ends at EMPLOYER and the arcrole's name says EMPLOYER; the Target
  // column and the `to` row both say EMPLOYMENT, which is not an element on the
  // DU emission path at all.
  { arcrole: "UNDERWRITING_VERIFICATION_IsAssociatedWith_EMPLOYER", end: "to" },
];

/**
 * The element an endpoint XPath ends at.
 *
 * The last segment, less its namespace prefix and less any predicate: the tab
 * writes `DEAL/LOANS/LOAN[LoanRoleType=”RelatedLoan”]` for one end and
 * `DU:UNDERWRITING_VERIFICATION` for another, and both name an element the
 * other columns spell bare.
 */
function endpointElement(xpath) {
  const last = xpath.split("/").pop() ?? "";
  return last.replace(/\[[^\]]*\]$/, "").replace(/^[^:]*:/, "");
}

/**
 * The arc an endpoints row describes, read out of the prose in its first
 * column: its name, and the element the name gives each end.
 *
 * The prose is the only column that names the same elements the arcrole URI
 * does — "UNDERWRITING_VERIFICATION is associated with ASSET" beside a Target
 * column reading OWNED_PROPERTY_DETAIL — so it is what joins the two sections
 * and what the `arcroleTerm` of each end comes from. Building the name out of
 * Source and Target instead would join those two rows to arcs that do not
 * exist.
 *
 * The verb phrase comes from its own column rather than from the words between,
 * and this asserts the two agree: "ROLE Shares Joint Credit Report With ROLE"
 * has five words in the middle, and picking the first and last word without
 * checking what lies between would make "ROLE owns ROLE" read as the same arc.
 */
function arcRoleFromProse(prose, verbPhrase, rowNumber) {
  const words = collapse(prose).split(" ").filter(Boolean);
  if (words.length < 3) {
    throw new Error(
      `${TABS.arcRoles} row ${rowNumber}: ${JSON.stringify(prose)} does not read as ` +
        "<SOURCE> <verb phrase> <TARGET>.",
    );
  }
  const middle = words.slice(1, -1).join("");
  if (middle.toLowerCase() !== verbPhrase.toLowerCase()) {
    throw new Error(
      `${TABS.arcRoles} row ${rowNumber}: ${JSON.stringify(prose)} spells the verb phrase ` +
        `${JSON.stringify(middle)}, and the Verb Phrase column says ${JSON.stringify(verbPhrase)}.`,
    );
  }
  const source = words[0];
  const target = words[words.length - 1];
  return { name: `${source}_${verbPhrase}_${target}`, source, target };
}

/**
 * Fold the Relationships Container section's rows into one block per arc.
 *
 * A block is a row carrying the arc's prose and the RELATIONSHIP XPath,
 * followed by rows that carry nothing but one property each. Every key is
 * recognized or the build stops: a row this loop skipped would be a property of
 * the graph that silently never reached the table.
 */
function foldRelationshipBlocks(rows) {
  const blocks = [];
  let block = null;
  for (const row of rows) {
    if (row.arcRole) {
      block = {
        rowNumber: row.rowNumber,
        prose: collapse(row.arcRole),
        xpath: normalizeXPath(row.xpath),
        notes: collapse(row.notes),
        attributes: [],
        declaration: null,
        name: null,
        ends: {},
      };
      blocks.push(block);
    }
    const attribute = collapse(row.attribute);
    const label = collapse(row.label);
    const value = collapse(row.value);
    if (!attribute && !label && !value) continue;
    if (!block) {
      throw new Error(
        `${TABS.arcRoles} row ${row.rowNumber} carries arc detail before any arc is named.`,
      );
    }
    if (attribute) {
      if (!ARCROLE_ATTRIBUTES.includes(attribute)) {
        throw new Error(
          `${TABS.arcRoles} row ${row.rowNumber}: unrecognized Attribute ` +
            `${JSON.stringify(attribute)}. Expected one of ${ARCROLE_ATTRIBUTES.join(", ")}.`,
        );
      }
      block.attributes.push(attribute);
    }
    if (!label) continue;
    if (label.startsWith("arcrole=")) {
      block.declaration = label;
      block.name = value;
    } else if (label === "from" || label === "to") {
      block.ends[label] = value;
    } else {
      throw new Error(
        `${TABS.arcRoles} row ${row.rowNumber}: unrecognized xLink:label row ` +
          `${JSON.stringify(label)}. Expected an arcrole declaration, "from" or "to".`,
      );
    }
  }
  return blocks;
}

/**
 * The arcrole URI a block declares, checked against the namespace both ways.
 *
 * The four short blocks declare `arcrole="urn:...:residential` with the name in
 * the cell beside them; the seven long ones declare the whole URI and repeat
 * the name. Either way the URI this returns is built from ARCROLE_NAMESPACE and
 * the name, so a cell that trails off mid-URN cannot become one.
 */
function arcRoleUri(block) {
  if (!block.name) {
    throw new Error(
      `${TABS.arcRoles} row ${block.rowNumber}: the arcrole declaration has no name.`,
    );
  }
  const uri = `${ARCROLE_NAMESPACE}/${block.name}`;
  const short = `arcrole="${ARCROLE_NAMESPACE}`;
  const long = `arcrole="${uri}"`;
  if (block.declaration !== short && block.declaration !== long) {
    throw new Error(
      `${TABS.arcRoles} row ${block.rowNumber}: ${JSON.stringify(block.declaration)} is neither ` +
        `${JSON.stringify(short)} nor ${JSON.stringify(long)}.\n` +
        "  The namespace moved, or the name and the URI disagree.",
    );
  }
  return uri;
}

/**
 * Every arcrole URI the vendored samples carry, and how many times.
 *
 * A regex over the bytes rather than an XML parse, because the question is
 * which URIs appear and not where: an arcrole in a comment would be a sample
 * Fannie Mae did not ship.
 */
export function arcRolesInCorpus(dir = SAMPLES_DIR) {
  const counts = new Map();
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".xml")) continue;
    const xml = readFileSync(join(dir, name), "utf8");
    for (const match of xml.matchAll(/\sxlink:arcrole="([^"]*)"/g)) {
      counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * The arc table: one entry per arc, both sections reconciled, each end carrying
 * every name the tab gives it.
 */
export function deriveArcRoles(sections, corpus, options = {}) {
  const disagreements = options.disagreements ?? ARCROLE_ENDPOINT_DISAGREEMENTS;
  const blocks = new Map();
  for (const block of foldRelationshipBlocks(sections.relationships)) {
    const uri = arcRoleUri(block);
    if (blocks.has(block.name)) {
      throw new Error(`${TABS.arcRoles} row ${block.rowNumber}: ${block.name} is described twice.`);
    }
    for (const end of ["from", "to"]) {
      if (!block.ends[end]) {
        throw new Error(
          `${TABS.arcRoles} row ${block.rowNumber}: ${block.name} has no ${end} row.`,
        );
      }
    }
    blocks.set(block.name, { ...block, uri });
  }

  const table = {};
  const disputed = [];
  const relationshipXPaths = new Set();
  for (const row of sections.endpoints) {
    const verbPhrase = collapse(row.verbPhrase);
    if (!ARCROLE_VERB_PHRASES.includes(verbPhrase)) {
      throw new Error(
        `${TABS.arcRoles} row ${row.rowNumber}: unrecognized Verb Phrase ` +
          `${JSON.stringify(verbPhrase)}. Expected one of ${ARCROLE_VERB_PHRASES.join(", ")}.`,
      );
    }
    const { name, ...terms } = arcRoleFromProse(row.arcRole, verbPhrase, row.rowNumber);
    const block = blocks.get(name);
    if (!block) {
      throw new Error(
        `${TABS.arcRoles} row ${row.rowNumber} describes the endpoints of ${name}, and the ` +
          `${JSON.stringify(ARCROLE_SECTIONS.relationships)} section does not carry it.`,
      );
    }
    if (table[name]) {
      throw new Error(`${TABS.arcRoles} row ${row.rowNumber}: ${name} has two endpoint rows.`);
    }
    blocks.delete(name);
    relationshipXPaths.add(block.xpath);

    const endpoint = (end, xpath, container, term) => {
      const names = [endpointElement(xpath), container, block.ends[end], term];
      const isDisputed = new Set(names).size > 1;
      if (isDisputed) disputed.push({ arcrole: name, end });
      return {
        xpath,
        container,
        relationshipEnd: block.ends[end],
        arcroleTerm: term,
        disputed: isDisputed,
      };
    };

    table[name] = {
      arcrole: block.uri,
      name,
      verbPhrase,
      from: endpoint("from", collapse(row.fromXPath), collapse(row.source), terms.source),
      to: endpoint("to", collapse(row.toXPath), collapse(row.target), terms.target),
      note: block.notes,
      exercised: corpus.has(block.uri),
    };
  }

  if (blocks.size) {
    throw new Error(
      `${TABS.arcRoles}: ${[...blocks.keys()].join(", ")} has a RELATIONSHIP block and no ` +
        `endpoints row.`,
    );
  }
  if (relationshipXPaths.size !== 1) {
    throw new Error(
      `${TABS.arcRoles}: the arcs name ${relationshipXPaths.size} different RELATIONSHIP ` +
        `XPaths: ${[...relationshipXPaths].join(", ")}.`,
    );
  }
  for (const uri of corpus.keys()) {
    if (!Object.values(table).some((arc) => arc.arcrole === uri)) {
      throw new Error(
        `The vendored samples carry ${uri}, and the ${TABS.arcRoles} tab does not describe it.`,
      );
    }
  }

  const key = (d) => `${d.arcrole} ${d.end}`;
  const found = new Set(disputed.map(key));
  const declared = new Set(disagreements.map(key));
  const surprises = [...found].filter((k) => !declared.has(k));
  if (surprises.length) {
    throw new Error(
      `${TABS.arcRoles} names different elements at these ends: ${surprises.join(", ")}.\n` +
        "  Read the tab, then add them to ARCROLE_ENDPOINT_DISAGREEMENTS. Do not pick one.",
    );
  }
  const healed = [...declared].filter((k) => !found.has(k));
  if (healed.length) {
    throw new Error(
      `ARCROLE_ENDPOINT_DISAGREEMENTS names ends the tab now agrees about: ${healed.join(", ")}.\n` +
        "  Delete those entries.",
    );
  }

  return { table, relationshipXPath: [...relationshipXPaths][0] };
}

// ── The du_* enum CHECK diff ───────────────────────────────────────────────

/**
 * Cut a migration into statements, honoring the four things a `;` can hide
 * inside: a single-quoted literal (with `''` escapes, and backslash escapes
 * after an `E` prefix), a `--` line comment, a slash-star block comment and a
 * dollar-quoted function body. Comments and function bodies are dropped from
 * the statement text, so an `IN (…)` inside a trigger body is never read as a
 * column's member list. An unterminated literal, comment or body throws:
 * a reader that guessed where one ended would attribute a list to the wrong
 * statement.
 */
export function splitSqlStatements(sql) {
  const statements = [];
  let current = "";
  let i = 0;
  const push = () => {
    if (current.trim()) statements.push(current.trim());
    current = "";
  };
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) throw new Error("unterminated /* comment in a migration");
      i = end + 2;
      continue;
    }
    if (ch === "'") {
      const before = sql[i - 1] ?? "";
      const escaped = /[Ee]/.test(before) && !/[A-Za-z0-9_]/.test(sql[i - 2] ?? "");
      let j = i + 1;
      while (j < sql.length) {
        if (escaped && sql[j] === "\\") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      if (j >= sql.length) throw new Error("unterminated string literal in a migration");
      current += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === "$") {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i, i + 64));
      if (tag) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        if (end === -1) throw new Error(`unterminated ${tag[0]} body in a migration`);
        current += " ";
        i = end + tag[0].length;
        continue;
      }
    }
    if (ch === ";") {
      push();
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  push();
  return statements;
}

const DU_TABLE = String.raw`"?(du_[A-Za-z0-9_]+)"?`;
const DU_COLUMN_COMMENT = /^DU ([A-Za-z][A-Za-z0-9:]*)(?:\. [\s\S]*)?$/;

/**
 * Every `du_*` column whose comment names a DU data point, and every
 * `<column> IN ('…', …)` list a CREATE TABLE or ALTER TABLE on a `du_*` table
 * spells — the convention stated at the top of this file.
 *
 * `comments` is keyed `table.column` → `{ dataPoint, file }`; `lists` is keyed
 * the same way and holds one entry per IN list, in migration order. The two
 * are joined by `diffDuEnumChecks`. Two migrations commenting one column with
 * two data points is an error here rather than a later-wins.
 */
export function duEnumChecksInMigrations(sources) {
  const comments = new Map();
  const lists = new Map();
  const commentPattern = new RegExp(
    String.raw`^COMMENT\s+ON\s+COLUMN\s+${DU_TABLE}\."?([A-Za-z0-9_]+)"?\s+IS\s+'((?:[^']|'')*)'$`,
    "i",
  );
  const tablePattern = new RegExp(
    String.raw`^(?:CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|ALTER\s+TABLE(?:\s+ONLY)?)\s+${DU_TABLE}(?![A-Za-z0-9_])`,
    "i",
  );
  const listPattern = /"?([A-Za-z0-9_]+)"?\s+(NOT\s+)?IN\s*\(\s*('(?:[^']|'')*'(?:\s*,\s*'(?:[^']|'')*')*)\s*\)/gi;
  for (const { file, sql } of sources) {
    for (const statement of splitSqlStatements(sql)) {
      const comment = commentPattern.exec(statement);
      if (comment) {
        const named = DU_COLUMN_COMMENT.exec(comment[3].replace(/''/g, "'"));
        if (!named) continue;
        const key = `${comment[1]}.${comment[2]}`;
        const prior = comments.get(key);
        if (prior && prior.dataPoint !== named[1]) {
          throw new Error(
            `${key} is commented "DU ${prior.dataPoint}" in ${prior.file} and ` +
              `"DU ${named[1]}" in ${file}. One column, one data point.`,
          );
        }
        comments.set(key, { dataPoint: named[1], file });
        continue;
      }
      const table = tablePattern.exec(statement);
      if (!table) continue;
      for (const list of statement.matchAll(listPattern)) {
        if (list[2]) continue;
        const key = `${table[1]}.${list[1]}`;
        const values = [...list[3].matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
        if (!lists.has(key)) lists.set(key, []);
        lists.get(key).push({ file, values });
      }
    }
  }
  return { comments, lists };
}

/**
 * Read the members back out of the generated enums.ts.
 *
 * This script wrote the file it is parsing, which is what makes a regex safe
 * here — and the shape is asserted, so a hand-edit that changes it stops the
 * check rather than being read as an empty enum. Parsing the committed file
 * rather than the workbook is deliberate: the enum CHECK diff is a check
 * between committed files, and it has to run on a machine that has no
 * DU_SPEC_DIR.
 */
export function parseGeneratedEnums(source) {
  const body = /export const DU_ENUMERATIONS[^=]*=\s*\{([\s\S]*?)\n\} as const;/.exec(source);
  if (!body) {
    throw new Error(
      `${OUT_REL}/enums.ts does not have the shape this script writes.\n` +
        "  Run: npm run du:build",
    );
  }
  const found = {};
  for (const entry of body[1].matchAll(/^ {2}(Du[A-Za-z0-9_]*):\s*\[([^\]]*)\],$/gm)) {
    found[entry[1]] = [...entry[2].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  }
  const local = /export const LOCAL_ENUMERATIONS[^=]*=\s*\[([^\]]*)\] as const;/.exec(source);
  return {
    enumerations: found,
    local: local ? [...local[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]) : [],
  };
}

/**
 * Read the two tables back out of the generated order.ts.
 *
 * Same reasoning as `parseGeneratedEnums`, and the same safety: this script
 * wrote the file, and `render` writes both tables with `JSON.stringify`, so the
 * literal between `=` and `as const;` is JSON and parses as JSON. A hand-edit
 * that breaks that shape stops the check instead of being read as an empty
 * table.
 */
export function parseGeneratedOrder(source) {
  const read = (name) => {
    const body = new RegExp(`export const ${name}[^=]*=\\s*(\\{[\\s\\S]*?\\n\\}) as const;`).exec(
      source,
    );
    if (!body) {
      throw new Error(
        `${OUT_REL}/order.ts has no ${name} in the shape this script writes.\n` +
          "  Run: npm run du:build",
      );
    }
    return JSON.parse(body[1]);
  };
  return { childOrder: read("CHILD_ORDER"), typeForPath: read("TYPE_FOR_PATH") };
}

/**
 * Re-derive the order table from the vendored XSDs and diff it against the
 * committed one.
 *
 * This is the half of the regeneration check that the vendored chain makes
 * runnable everywhere, and it is worth having separately from the full rebuild:
 * CI has no DU_SPEC_DIR, so without it every child sequence in `order.ts` would
 * be unchecked on the only machine that gates a merge.
 *
 * The XPaths come from the committed `TYPE_FOR_PATH` rather than from the
 * workbook, which is what lets it run at all — and it is also the limit of what
 * it can see. An XPath the workbook ADDED is invisible here, because a table
 * that never learned about it is self-consistent; that is the workbook's half
 * and it stays there. What this catches is every child sequence moving under a
 * re-vendored XSD, and every hand-edit of the committed table.
 */
export function schemaOrderProblems(source) {
  const committed = parseGeneratedOrder(source);
  const xpaths = Object.keys(committed.typeForPath).sort();
  const derived = buildOrderTable(parseSchemas(), xpaths);

  const problems = [];
  for (const [type, children] of derived.order) {
    const was = committed.childOrder[type];
    if (!was) problems.push(`${type} is in the schema chain and not in CHILD_ORDER`);
    else if (was.join("|") !== children.join("|")) {
      problems.push(`${type}: the schema chain now declares ${children.join(", ")}`);
    }
  }
  for (const type of Object.keys(committed.childOrder)) {
    if (!derived.order.has(type)) problems.push(`${type} is in CHILD_ORDER and not in the chain`);
  }
  for (const [xpath, type] of derived.typeForPath) {
    if (committed.typeForPath[xpath] !== type) {
      problems.push(`${xpath} now resolves to ${type}`);
    }
  }
  return { problems, count: derived.order.size };
}

function runSchemaOrderCheck() {
  const { problems, count } = schemaOrderProblems(readFileSync(resolve(OUT_DIR, "order.ts"), "utf8"));
  if (problems.length) {
    console.error(`✗ ${OUT_REL}/order.ts and ${relative(ROOT, XSD_DIR)} disagree:`);
    for (const problem of problems) console.error(`    ${problem}`);
    console.error("    Run: npm run du:build");
    return false;
  }
  console.log(`✓ ${count} child sequences in order.ts match the vendored MISMO chain`);
  return true;
}

/**
 * The committed arc table, read back.
 *
 * Same reasoning and the same safety as `parseGeneratedOrder`: `render` writes
 * the literal with `JSON.stringify`, so what sits between `=` and `as const;`
 * is JSON, and a hand-edit that breaks its shape stops the check rather than
 * being read as an empty table.
 */
export function parseGeneratedArcRoles(source) {
  const body = /export const DU_ARCROLES[^=]*=\s*(\{[\s\S]*?\n\}) as const;/.exec(source);
  if (!body) {
    throw new Error(
      `${OUT_REL}/arcroles.ts has no DU_ARCROLES in the shape this script ` +
        "writes.\n  Run: npm run du:build",
    );
  }
  return JSON.parse(body[1]);
}

/**
 * Diff the committed arc table's corpus column against the vendored samples.
 *
 * This is the arc table's half of what `runSchemaOrderCheck` does for element
 * order: the endpoints come from the licensed workbook and are only checkable
 * where it is, but which arcs a shipped DU document actually carries is a fact
 * about eighteen files in this repository, so it is checkable everywhere and
 * checked on the machine that gates a merge.
 *
 * What it does NOT see is everything the workbook is the authority on: an arc
 * the tab added, and every endpoint on every arc. Those are the workbook diff's
 * to catch, and with DU_SPEC_DIR unset the only thing standing over them is
 * `generated.test.ts`, which writes both disputed ends out in full.
 */
function runArcRoleCorpusCheck() {
  const committed = parseGeneratedArcRoles(readFileSync(resolve(OUT_DIR, "arcroles.ts"), "utf8"));
  const corpus = arcRolesInCorpus();

  const problems = [];
  for (const [name, arc] of Object.entries(committed)) {
    if (arc.arcrole !== `${ARCROLE_NAMESPACE}/${name}`) {
      problems.push(`${name} carries the URI ${arc.arcrole}`);
    }
    const exercised = corpus.has(arc.arcrole);
    if (arc.exercised !== exercised) {
      problems.push(
        exercised
          ? `${name} is marked unexercised, and the samples carry it ${corpus.get(arc.arcrole)} times`
          : `${name} is marked exercised, and no sample carries it`,
      );
    }
  }
  for (const uri of corpus.keys()) {
    if (!Object.values(committed).some((arc) => arc.arcrole === uri)) {
      problems.push(`the samples carry ${uri}, which DU_ARCROLES does not describe`);
    }
  }

  if (problems.length) {
    console.error(`✗ ${OUT_REL}/arcroles.ts and the vendored samples disagree:`);
    for (const problem of problems) console.error(`    ${problem}`);
    console.error("    Run: npm run du:build");
    return false;
  }
  const exercised = Object.values(committed).filter((arc) => arc.exercised).length;
  console.log(
    `✓ ${exercised} of ${Object.keys(committed).length} arcroles in arcroles.ts are exercised ` +
      "by the vendored samples, and no sample carries another",
  );
  return true;
}

/**
 * Diff every DU-commented `du_*` column's CHECK members against the values the
 * spec derives.
 *
 * A member in either direction fails. This is the check that would have caught
 * `SecuredBorrowedFundsNotDeposited` — a value that lived in a block labeled
 * "generated", was in no tab of the spec, and was in no MISMO type either. The
 * comment names a data point; DU_DATA_POINT_FOR_ENUM says which enum that
 * data point feeds; `derived` is that enum's member list out of `enums.ts`.
 * A column whose comment names a data point the table does not map fails
 * rather than being skipped, and so does a commented column with no IN list.
 */
export function diffDuEnumChecks(found, derived, table = DU_DATA_POINT_FOR_ENUM) {
  const enumFor = new Map();
  for (const [enumName, spec] of Object.entries(table)) {
    for (const dataPoint of spec.dataPoints ?? []) {
      const prior = enumFor.get(dataPoint.name);
      if (prior && prior !== enumName) {
        throw new Error(
          `DU_DATA_POINT_FOR_ENUM maps ${dataPoint.name} to both ${prior} and ${enumName}; a ` +
            `column commented "DU ${dataPoint.name}" cannot be diffed against two enums.`,
        );
      }
      enumFor.set(dataPoint.name, enumName);
    }
  }

  const problems = [];
  for (const [column, { dataPoint, file }] of found.comments) {
    const enumName = enumFor.get(dataPoint);
    if (!enumName) {
      problems.push(
        `${column} is commented "DU ${dataPoint}" (${file}), and ${dataPoint} is not a data ` +
          "point DU_DATA_POINT_FOR_ENUM maps. Give it a Du* enum, or drop the comment.",
      );
      continue;
    }
    const expected = derived[enumName];
    if (!expected) {
      problems.push(
        `${column} is commented "DU ${dataPoint}", which is ${enumName}, and enums.ts carries ` +
          `no ${enumName}. Run: npm run du:build`,
      );
      continue;
    }
    const lists = found.lists.get(column) ?? [];
    if (!lists.length) {
      problems.push(
        `${column} is commented "DU ${dataPoint}" and no CHECK on ${column.split(".")[0]} ` +
          "names the values it admits.",
      );
      continue;
    }
    const members = [];
    for (const list of lists) {
      for (const value of list.values) if (!members.includes(value)) members.push(value);
    }
    for (const member of members) {
      if (!expected.includes(member)) {
        problems.push(
          `${column} admits ${member}, which has no row in the DU Enumerations tab for ` +
            `${dataPoint} (${enumName}).`,
        );
      }
    }
    for (const value of expected) {
      if (!members.includes(value)) {
        problems.push(
          `${column} is missing ${value}, which the DU Enumerations tab carries for ` +
            `${dataPoint} (${enumName}).`,
        );
      }
    }
  }
  return problems;
}

// ── Reading the workbook into rows ─────────────────────────────────────────

const MAP_COLUMNS = {
  formFieldId: 2,
  formFieldName: 3,
  xpath: 4,
  dataPoint: 6,
  format: 9,
  attribute: 10,
  du: 13,
  conditionality: 18,
};

const ENUMERATION_COLUMNS = {
  formFieldId: 2,
  formFieldName: 3,
  dataPoint: 4,
  value: 5,
  ediCode: 9,
};

const CARDINALITY_COLUMNS = { xpath: 0, container: 2, du: 3, fhaVa: 4 };

const ARCROLE_ENDPOINT_COLUMNS = {
  arcRole: 0,
  fromXPath: 1,
  source: 2,
  verbPhrase: 3,
  toXPath: 4,
  target: 5,
};

const ARCROLE_RELATIONSHIP_COLUMNS = {
  arcRole: 0,
  xpath: 1,
  attribute: 2,
  label: 3,
  value: 4,
  notes: 5,
};

const HEADER_ROWS = { map: 3, enumerations: 3, cardinality: 2 };

/**
 * Cut the ArcRoles tab into its two sections and read each one's rows.
 *
 * The tab has no fixed header row: its two tables sit wherever the sub-headings
 * put them, and a version that grows a note above one of them would move both.
 * So the sub-headings are what this finds, and its own header row is the row
 * under each — which is also the row `assertColumns` compares to Column
 * Description, so a reordered column on either table still stops the build.
 */
export function readArcRoleSections(rows, columnDescription) {
  const expected = arcRoleColumnNamesFor(columnDescription, ARCROLE_SECTIONS);
  const headings = new Map(Object.entries(ARCROLE_SECTIONS).map(([key, name]) => [name, key]));
  const bodies = {};
  let current = null;
  for (const row of rows) {
    const key = headings.get(collapse(text(row, 1)));
    if (key) {
      current = { key, header: null, rows: [] };
      bodies[key] = current;
      continue;
    }
    if (!current) continue;
    if (!current.header) {
      current.header = row;
      assertColumns(
        `${TABS.arcRoles} (${ARCROLE_SECTIONS[current.key]})`,
        row,
        expected[current.key],
      );
      continue;
    }
    if (!row.cells.some((c) => (c ?? "").trim())) continue;
    current.rows.push(row);
  }
  for (const key of Object.keys(ARCROLE_SECTIONS)) {
    if (!bodies[key]?.rows.length) {
      throw new Error(
        `The ${JSON.stringify(TABS.arcRoles)} tab has no rows under ` +
          `${JSON.stringify(ARCROLE_SECTIONS[key])}.`,
      );
    }
  }

  const read = (body, columns) =>
    body.rows.map((row) => {
      const out = { rowNumber: row.number };
      for (const [name, index] of Object.entries(columns)) out[name] = text(row, index);
      return out;
    });
  return {
    endpoints: read(bodies.endpoints, ARCROLE_ENDPOINT_COLUMNS),
    relationships: read(bodies.relationships, ARCROLE_RELATIONSHIP_COLUMNS),
  };
}

function readSpec(paths) {
  const book = readWorkbook(paths.workbook);

  const cover = book
    .sheet(TABS.frontCover)
    .map((r) => r.cells.map((c) => collapse(c)).join(" "))
    .join("\n");
  const version = /Document Version ([\d.]+)/.exec(cover)?.[1];
  if (version !== SPEC_VERSION) {
    throw new Error(
      `The workbook is DU Spec ${version ?? "(no version on the front cover)"}, and every ` +
        `mapping in this script was read against ${SPEC_VERSION}.\n` +
        "  Re-read the tabs, then move SPEC_VERSION.",
    );
  }

  const columnDescription = book.sheet(TABS.columnDescription);
  const mapRows = book.sheet(TABS.map);
  const enumerationRows = book.sheet(TABS.enumerations);
  const cardinalityRows = book.sheet(TABS.cardinality);
  assertColumns(
    TABS.map,
    mapRows[HEADER_ROWS.map - 1],
    columnNamesFor(columnDescription, "DU Map Tab"),
  );
  assertColumns(
    TABS.enumerations,
    enumerationRows[HEADER_ROWS.enumerations - 1],
    columnNamesFor(columnDescription, "DU Enumerations Tab"),
  );
  assertColumns(
    TABS.cardinality,
    cardinalityRows[HEADER_ROWS.cardinality - 1],
    columnNamesFor(columnDescription, "Cardinality Tab"),
  );

  const map = [];
  for (const row of mapRows.slice(HEADER_ROWS.map)) {
    if (!row.cells.some((c) => (c ?? "").trim())) continue;
    map.push({
      rowNumber: row.number,
      formFieldId: normalizeFormFieldId(text(row, MAP_COLUMNS.formFieldId)),
      formFieldName: collapse(text(row, MAP_COLUMNS.formFieldName)),
      xpath: normalizeXPath(text(row, MAP_COLUMNS.xpath)),
      dataPoint: text(row, MAP_COLUMNS.dataPoint),
      attribute: text(row, MAP_COLUMNS.attribute),
      format: text(row, MAP_COLUMNS.format),
      du: collapse(text(row, MAP_COLUMNS.du)),
      conditionality: collapse(text(row, MAP_COLUMNS.conditionality)),
    });
  }

  const enumerations = [];
  for (const row of enumerationRows.slice(HEADER_ROWS.enumerations)) {
    if (!row.cells.some((c) => (c ?? "").trim())) continue;
    enumerations.push({
      rowNumber: row.number,
      formFieldId: normalizeFormFieldId(text(row, ENUMERATION_COLUMNS.formFieldId)),
      formFieldName: collapse(text(row, ENUMERATION_COLUMNS.formFieldName)),
      dataPoint: text(row, ENUMERATION_COLUMNS.dataPoint),
      value: text(row, ENUMERATION_COLUMNS.value),
      ediCode: collapse(text(row, ENUMERATION_COLUMNS.ediCode)),
    });
  }

  const cardinality = [];
  for (const row of cardinalityRows.slice(HEADER_ROWS.cardinality)) {
    if (!row.cells.some((c) => (c ?? "").trim())) continue;
    cardinality.push({
      rowNumber: row.number,
      xpath: normalizeXPath(text(row, CARDINALITY_COLUMNS.xpath)),
      container: text(row, CARDINALITY_COLUMNS.container),
      du: text(row, CARDINALITY_COLUMNS.du),
      fhaVa: text(row, CARDINALITY_COLUMNS.fhaVa),
    });
  }

  return {
    map,
    enumerations,
    cardinality,
    arcRoles: readArcRoleSections(book.sheet(TABS.arcRoles), columnDescription),
  };
}

// ── Building the five tables ───────────────────────────────────────────────

/**
 * Assert the two tabs agree about where a field lives, wherever this script
 * says they do not.
 *
 * The reconciliation is only trustworthy because both tabs give the field the
 * same NAME under their two different ids. Checking that is what keeps
 * TAB_DISAGREEMENTS from being a list of guesses, and it is why a fifth
 * disagreement has to be looked at by somebody rather than added by pattern.
 */
export function checkTabDisagreements(map, enumerations, options = {}) {
  const table = options.table ?? DU_DATA_POINT_FOR_ENUM;
  const disagreements = options.disagreements ?? TAB_DISAGREEMENTS;
  const enumerationKeys = new Set(enumerations.map((r) => `${r.dataPoint} ${r.formFieldId}`));
  const declared = new Set();
  for (const spec of Object.values(table)) {
    for (const dataPoint of spec.dataPoints ?? []) declared.add(dataPoint.name);
  }

  const unused = new Set(disagreements.map((_, i) => i));
  for (const row of map) {
    if (!declared.has(row.dataPoint)) continue;
    if (!/Enumerated/.test(collapse(row.format))) continue;
    if (enumerationKeys.has(`${row.dataPoint} ${row.formFieldId}`)) continue;
    const index = disagreements.findIndex(
      (d) => d.dataPoint === row.dataPoint && d.mapFormField === row.formFieldId,
    );
    if (index === -1) {
      throw new Error(
        `${TABS.map} row ${row.rowNumber} files ${row.dataPoint} under form field ` +
          `${JSON.stringify(row.formFieldId)}, and the ${TABS.enumerations} tab has no such ` +
          "row.\n  Find where the tab files it and add a TAB_DISAGREEMENTS entry.",
      );
    }
    unused.delete(index);
    const target = disagreements[index];
    const other = enumerations.filter(
      (r) => r.dataPoint === row.dataPoint && r.formFieldId === target.enumerationFormField,
    );
    if (!other.length) {
      throw new Error(
        `TAB_DISAGREEMENTS sends ${row.dataPoint} ${target.mapFormField} to form field ` +
          `${target.enumerationFormField}, which the ${TABS.enumerations} tab does not carry.`,
      );
    }
    if (other.some((r) => r.formFieldName !== row.formFieldName)) {
      throw new Error(
        `TAB_DISAGREEMENTS sends ${row.dataPoint} ${target.mapFormField} ` +
          `(${JSON.stringify(row.formFieldName)}) to form field ${target.enumerationFormField}, ` +
          `which the tab calls ${JSON.stringify(other[0].formFieldName)}.\n` +
          "  The two tabs disagree about more than the number. Do not reconcile them.",
      );
    }
  }
  if (unused.size) {
    const stale = [...unused].map(
      (i) => `${disagreements[i].dataPoint} ${disagreements[i].mapFormField}`,
    );
    throw new Error(
      `TAB_DISAGREEMENTS names reconciliations nothing needs: ${stale.join(", ")}.\n` +
        "  The tabs agree now. Delete those entries.",
    );
  }
}

function buildFormats(map) {
  const formats = {};
  const blanksUsed = new Set();
  for (const row of map) {
    const name = row.dataPoint || row.attribute;
    if (!row.xpath || !name) continue;
    const key = `${row.xpath}#${name}#${row.formFieldId}`;
    let format;
    if (!row.format) {
      const index = BLANK_FORMAT_ROWS.findIndex(
        (b) => b.xpath === row.xpath && b.dataPoint === name,
      );
      if (index === -1) {
        throw new Error(
          `${TABS.map} row ${row.rowNumber} gives ${name} at ${row.xpath} no format.\n` +
            "  Add it to BLANK_FORMAT_ROWS. Do not invent a width.",
        );
      }
      blanksUsed.add(index);
      format = null;
    } else {
      format = parseFormat(row.format);
    }
    const existing = formats[key];
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(format)) {
      throw new Error(
        `${name} at ${row.xpath} form field ${JSON.stringify(row.formFieldId)} is ` +
          `${JSON.stringify(row.format)} on row ${row.rowNumber} and something else on another ` +
          "row. One destination, one width.",
      );
    }
    formats[key] = format;
  }
  const stale = BLANK_FORMAT_ROWS.filter((_, i) => !blanksUsed.has(i));
  if (stale.length) {
    throw new Error(
      `BLANK_FORMAT_ROWS names rows that now carry a format: ${stale
        .map((b) => `${b.dataPoint} at ${b.xpath}`)
        .join(", ")}.`,
    );
  }
  return formats;
}

function buildConditionality(map) {
  const statements = new Map();
  const entries = [];
  const seen = new Map();
  for (const row of map) {
    const name = row.dataPoint || row.attribute;
    if (!row.xpath || !name) continue;
    if (!row.du) continue;
    const requirement = REQUIREMENT[row.du];
    if (!requirement) {
      throw new Error(
        `${TABS.map} row ${row.rowNumber}: unrecognized Desktop Underwriter (DU) value ` +
          `${JSON.stringify(row.du)}. Expected one of ${Object.keys(REQUIREMENT).join(", ")}.`,
      );
    }
    let condition = null;
    if (requirement === "conditional") {
      if (!row.conditionality) {
        throw new Error(
          `${TABS.map} row ${row.rowNumber}: ${name} is conditional with no statement beside it.`,
        );
      }
      if (!statements.has(row.conditionality)) {
        statements.set(row.conditionality, parseConditionality(row.conditionality));
      }
      condition = row.conditionality;
    }
    const entry = {
      xpath: row.xpath,
      name,
      attribute: Boolean(!row.dataPoint && row.attribute),
      formFieldId: row.formFieldId,
      requirement,
      condition,
    };
    const key = `${entry.xpath}#${entry.name}#${entry.formFieldId}`;
    const already = seen.get(key);
    if (already && JSON.stringify(already) !== JSON.stringify(entry)) {
      throw new Error(
        `${TABS.map} row ${row.rowNumber}: two rows share ` +
          `(${entry.xpath}, ${entry.name}, ${entry.formFieldId}) and disagree about ` +
          "conditionality. The key is not unique any more.",
      );
    }
    if (already) continue;
    seen.set(key, entry);
    entries.push(entry);
  }
  return { entries, statements };
}

function buildCardinality(rows) {
  const table = {};
  for (const row of rows) {
    if (!row.xpath) continue;
    const value = {
      container: row.container,
      du: parseCardinality(row.du, row.xpath),
      fhaVa: parseCardinality(row.fhaVa, row.xpath),
    };
    const existing = table[row.xpath];
    if (existing && JSON.stringify(existing) !== JSON.stringify(value)) {
      throw new Error(
        `${TABS.cardinality} row ${row.rowNumber}: ${row.xpath} appears twice with different ` +
          "cardinality.",
      );
    }
    table[row.xpath] = value;
  }
  return table;
}

function buildArcRoles(sections) {
  return deriveArcRoles(sections, arcRolesInCorpus());
}

// ── Emitting ───────────────────────────────────────────────────────────────

const banner = (what) => `// GENERATED by scripts/build-du.mjs from the DU Spec ${SPEC_VERSION}
// workbook, which is licensed and is not in this repository — see DU_SPEC_DIR
// in that script — and the MISMO v3.4 B324 schema chain, which is vendored in
// packages/du-schema/xsd.
// Do not edit. Run \`npm run du:build\`; \`npm run du:verify\` fails on drift.
//
// ${what}`;

function render(spec) {
  const { order, typeForPath } = spec.order;
  const orderObject = Object.fromEntries([...order].sort(([a], [b]) => (a < b ? -1 : 1)));
  const pathObject = Object.fromEntries([...typeForPath].sort(([a], [b]) => (a < b ? -1 : 1)));

  const files = {};

  files["order.ts"] = `${banner(
    "The child sequence of every complex type on the DU emission path, in\n" +
      "// schema order. Never sort this — MISMO's order is what the XSD enforces, and\n" +
      "// alphabetical-with-EXTENSION-last is wrong for DEAL, PARTY, ROLE, EMPLOYER,\n" +
      "// COLLATERAL, CONTACT_POINT, LICENSE and DOCUMENT_SPECIFIC_DATA_SET among others.",
  )}

export const CHILD_ORDER: Readonly<Record<string, readonly string[]>> = ${JSON.stringify(
    orderObject,
    null,
    2,
  )} as const;

/** The complex type each container XPath in the DU Map and Cardinality tabs resolves to. */
export const TYPE_FOR_PATH: Readonly<Record<string, string>> = ${JSON.stringify(
    pathObject,
    null,
    2,
  )} as const;
`;

  files["enums.ts"] = `${banner(
    "The DU-supported members of every Du* enum, from the DU Enumerations tab\n" +
      "// and NOT from the XSD — the XSD is wider and admits DU-illegal values.\n" +
      "// Spellings are verbatim: AccessoryUnitIincome, with the double lowercase i,\n" +
      "// is canonical in MISMOEnumeratedTypesB324.xsd itself.",
  )}

export const DU_ENUMERATIONS: Readonly<Record<string, readonly string[]>> = {
${Object.entries(spec.enumerations.enumerations)
  .map(([name, values]) => `  ${name}: [${values.map((v) => JSON.stringify(v)).join(", ")}],`)
  .join("\n")}
} as const;

/** Enums that are ours, with no DU data point behind them and nothing to diff. */
export const LOCAL_ENUMERATIONS: readonly string[] = [${spec.enumerations.local
    .map((n) => JSON.stringify(n))
    .join(", ")}] as const;

/**
 * AssetType, split by the URLA section the DU Enumerations tab files each
 * member under. The union is DuAssetType; the split is which values each
 * du_assets.kind may take, and the per-kind CHECKs in
 * 20260913110000_an_asset_has_an_owner are diffed against it by du:verify.
 */
export const DU_ASSET_TYPES_BY_SECTION: Readonly<Record<string, readonly string[]>> = {
${Object.entries(spec.assetTypeSections)
  .map(
    ([field, values]) =>
      `  ${JSON.stringify(field)}: [${values.map((v) => JSON.stringify(v)).join(", ")}],`,
  )
  .join("\n")}
} as const;
`;

  files["lengths.ts"] = `${banner(
    "The DU data point format at each destination, keyed\n" +
      "// `XPath#DataPointName#FormFieldId`. Widths are not uniform across destinations\n" +
      "// for the same data point — AddressLineText is String 50 under the subject\n" +
      "// property and String 35 under an owned property — and not uniform WITHIN a\n" +
      "// destination either: LOAN_IDENTIFIER carries LoanIdentifier at String 15, 30 and\n" +
      "// 45 depending on which identifier it is, which is why the form field is part of\n" +
      "// the key. Nothing anywhere compares two renderings for equality; equality is the\n" +
      "// wrong invariant when two destinations have different widths. A null format is a\n" +
      "// row the workbook leaves blank; it is not a default.",
  )}

export interface DuFormat {
  readonly kind: string;
  readonly maxLength?: number;
  readonly digits?: number;
  readonly decimals?: number;
}

export const DU_FORMATS: Readonly<Record<string, DuFormat | null>> = ${JSON.stringify(
    Object.fromEntries(Object.entries(spec.formats).sort(([a], [b]) => (a < b ? -1 : 1))),
    null,
    2,
  )} as const;
`;

  files["cardinality.ts"] = `${banner(
    "How many times each container may repeat, per product, from the\n" +
      "// Cardinality tab. A null is an N/A cell: the product does not carry that\n" +
      "// container at all.",
  )}

export interface DuCardinality {
  readonly min: number;
  readonly max: number;
}

export interface DuContainerCardinality {
  readonly container: string;
  readonly du: DuCardinality | null;
  readonly fhaVa: DuCardinality | null;
}

export const DU_CARDINALITY: Readonly<Record<string, DuContainerCardinality>> = ${JSON.stringify(
    Object.fromEntries(Object.entries(spec.cardinality).sort(([a], [b]) => (a < b ? -1 : 1))),
    null,
    2,
  )} as const;
`;

  files["arcroles.ts"] = `${banner(
    "The relationship graph: every arc the ArcRoles tab describes, its URI, the\n" +
      "// container at each end, and whether any of Fannie Mae's eighteen shipped test\n" +
      "// cases actually carries it. A DU submission is a graph and not a nested\n" +
      "// document — containers carry an xlink:label and RELATIONSHIP elements arc\n" +
      "// between them — and this is the graph's shape, known to the code rather than\n" +
      "// transcribed into an emitter by hand.",
  )}

/**
 * One end of an arc, under all four names the tab gives it.
 *
 * Four, and not one, because at two ends they do not agree — see \`disputed\`.
 * Nothing in the generator picks a winner, and nothing downstream should pick
 * one silently either: the choice is a question for Fannie Mae.
 */
export interface DuArcRoleEndpoint {
  /** The endpoint XPath, verbatim, predicates and all. */
  readonly xpath: string;
  /** What the tab's Source or Target column calls the container there. */
  readonly container: string;
  /** What the RELATIONSHIP section's \`from\` or \`to\` row calls it. */
  readonly relationshipEnd: string;
  /** What the arcrole URI itself calls it. */
  readonly arcroleTerm: string;
  /** True when those four do not all name the same element. */
  readonly disputed: boolean;
}

export interface DuArcRole {
  /** The full URI, as it appears in an \`xlink:arcrole\` attribute. */
  readonly arcrole: string;
  /** The URI's last segment, and the key of this table. */
  readonly name: string;
  readonly verbPhrase: string;
  readonly from: DuArcRoleEndpoint;
  readonly to: DuArcRoleEndpoint;
  /** The tab's Notes column: when DU requires the arc. Not parsed. */
  readonly note: string;
  /**
   * True when at least one of the eighteen vendored samples carries this
   * arcrole. False is not "wrong" — it is an arc nobody has seen a shipped DU
   * document use, which is worth knowing before an emitter relies on it.
   */
  readonly exercised: boolean;
}

/** The container every arc lives in. One XPath, asserted by the generator. */
export const DU_RELATIONSHIP_XPATH = ${JSON.stringify(spec.arcRoles.relationshipXPath)};

export const DU_ARCROLES: Readonly<Record<string, DuArcRole>> = ${JSON.stringify(
    Object.fromEntries(Object.entries(spec.arcRoles.table).sort(([a], [b]) => (a < b ? -1 : 1))),
    null,
    2,
  )} as const;
`;

  const statements = Object.fromEntries(
    [...spec.conditionality.statements].sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  files["conditionality.ts"] = `${banner(
    "What DU requires at each destination, and — where it is conditional — the\n" +
      "// statement it is conditional on, parsed. The predicates themselves are not\n" +
      "// implemented here: a condition is a tree over data point names, and what\n" +
      "// evaluates it against a loan file is the preflight, not the generator.",
  )}

export type DuRequirement = "required" | "optional" | "conditional" | "not_applicable";

export type DuCondition =
  | { readonly kind: "self_exists" }
  | { readonly kind: "exists"; readonly dataPoint: string }
  | { readonly kind: "absent"; readonly dataPoint: string }
  | {
      readonly kind: "compare";
      readonly dataPoint: string;
      readonly operator: string;
      readonly value: string | number;
    }
  | { readonly kind: "in"; readonly dataPoint: string; readonly values: readonly string[] }
  | { readonly kind: "and"; readonly terms: readonly DuCondition[] }
  | { readonly kind: "or"; readonly terms: readonly DuCondition[] };

export interface DuConditionalityEntry {
  readonly xpath: string;
  readonly name: string;
  /** True when the row names an XML attribute rather than a child element. */
  readonly attribute: boolean;
  readonly formFieldId: string;
  readonly requirement: DuRequirement;
  /** The statement verbatim, and the key into DU_CONDITION_STATEMENTS. */
  readonly condition: string | null;
}

export const DU_CONDITIONALITY: readonly DuConditionalityEntry[] = ${JSON.stringify(
    spec.conditionality.entries,
    null,
    2,
  )} as const;

export const DU_CONDITION_STATEMENTS: Readonly<Record<string, DuCondition>> = ${JSON.stringify(
    statements,
    null,
    2,
  )} as const;
`;

  return files;
}

export function buildFromSpec(paths) {
  const spec = readSpec(paths);
  checkTabDisagreements(spec.map, spec.enumerations);

  const xpaths = new Set();
  for (const row of spec.map) if (row.xpath) xpaths.add(row.xpath);
  for (const row of spec.cardinality) if (row.xpath) xpaths.add(row.xpath);

  return render({
    order: buildOrderTable(parseSchemas(), [...xpaths].sort()),
    enumerations: deriveEnumerations(spec.enumerations),
    assetTypeSections: deriveAssetTypeSections(spec.enumerations),
    formats: buildFormats(spec.map),
    cardinality: buildCardinality(spec.cardinality),
    conditionality: buildConditionality(spec.map),
    arcRoles: buildArcRoles(spec.arcRoles),
  });
}

// ── main ───────────────────────────────────────────────────────────────────

function runEnumCheckDiff() {
  const graph = duGraphMigrationPaths();
  if (!graph.length) {
    console.log(`- skipped the du_* enum CHECK diff: no ${DU_GRAPH_MIGRATION_GLOB} yet (Phase 3)`);
    return true;
  }
  const found = duEnumChecksInMigrations(migrationSources());
  if (!found.comments.size) {
    console.error(
      `✗ ${graph.join(", ")} exists and no du_* column carries a 'DU <DataPoint>' comment, so ` +
        "the enum CHECK diff has nothing to read.",
    );
    console.error("    The convention is stated at the top of tools/build-du.mjs.");
    return false;
  }
  const generated = parseGeneratedEnums(readFileSync(resolve(OUT_DIR, "enums.ts"), "utf8"));
  const problems = diffDuEnumChecks(found, generated.enumerations);
  if (problems.length) {
    console.error("✗ the du_* enum CHECKs in db/migrations and the DU Spec disagree:");
    for (const problem of problems) console.error(`    ${problem}`);
    return false;
  }
  console.log(`✓ ${found.comments.size} du_* enum CHECK(s) in db/migrations match the DU Spec`);
  return true;
}

/**
 * The per-kind CHECKs still admit exactly the values their URLA section carries.
 *
 * Two committed files, like the enum CHECK diff above and for the same reason:
 * this has to run in CI on a machine with no DU_SPEC_DIR, because the failure
 * it catches is a widened CHECK and a widened CHECK has no local symptom at
 * all.
 *
 * It reads the value list and nothing else. Everything the same CHECK says
 * about nulls, amounts and the columns each kind forbids is invisible here and
 * belongs to the DB-backed suite that writes rows (23.5's), which is what
 * knows that a row with no AssetType at all is refused — not a fact about the
 * list.
 */
function runAssetShapeCheck() {
  const paths = duGraphMigrationPaths();
  if (!paths.length) {
    console.log(`- skipped the per-kind asset CHECK diff: no ${DU_GRAPH_MIGRATION_GLOB} yet (Phase 3)`);
    return true;
  }
  if (paths.length > 1) {
    console.error(
      `✗ ${DU_GRAPH_MIGRATION_GLOB} matches ${paths.length} files (${paths.join(", ")}); the ` +
        "per-kind asset CHECKs live in one.",
    );
    return false;
  }
  const generated = readFileSync(resolve(OUT_DIR, "enums.ts"), "utf8");
  const sections = parseGeneratedAssetTypeSections(generated);
  const members = parseGeneratedEnums(generated).enumerations.DuAssetType ?? [];
  const migration = assetTypeListsInMigration(readFileSync(resolve(ROOT, paths[0]), "utf8"), {
    path: paths[0],
  });
  const problems = diffAssetTypeChecks(sections, migration, members);
  if (problems.length) {
    console.error("✗ the per-kind asset CHECKs and the DU Spec disagree:");
    for (const problem of problems) console.error(`    ${problem}`);
    return false;
  }
  console.log(
    `✓ ${ASSET_TYPE_SECTIONS.length} per-kind asset CHECK(s) admit exactly their section's ` +
      `${members.length} AssetType values`,
  );
  return true;
}

async function main() {
  const verify = process.argv.includes("--verify");

  if (verify) {
    let ok = runEnumCheckDiff();
    if (!runSchemaOrderCheck()) ok = false;
    if (!runArcRoleCorpusCheck()) ok = false;
    if (!runAssetShapeCheck()) ok = false;
    let files;
    try {
      files = buildFromSpec(resolveSpecFiles());
    } catch (error) {
      if (!(error instanceof SpecUnavailableError)) throw error;
      // An unset DU_SPEC_DIR is the documented way to say the licensed workbook
      // is not on this machine, and skipping is the whole point of it. A set
      // one is somebody asking for the check, so a path that does not hold the
      // workbook fails rather than reporting itself as an absent one.
      if (!error.unset) throw error;
      // Named files, not "the regeneration check": order.ts was checked against
      // the vendored chain a few lines up, and arcroles.ts had its corpus
      // column checked against the vendored samples. A message that says a
      // check was skipped when most of one ran is how somebody comes to
      // re-point DU_SPEC_DIR at a corpus they did not need.
      console.log(
        "- skipped the workbook check (enums, lengths, cardinality, conditionality, and the " +
          "arcroles' endpoints): DU_SPEC_DIR is not set",
      );
      process.exit(ok ? 0 : 1);
    }
    for (const [name, contents] of Object.entries(files)) {
      const path = resolve(OUT_DIR, name);
      let current = null;
      try {
        current = readFileSync(path, "utf8");
      } catch {
        current = null;
      }
      if (current !== contents) {
        console.error(`✗ ${OUT_REL}/${name} is out of date. Run: npm run du:build`);
        ok = false;
      }
    }
    if (!ok) process.exit(1);
    console.log(`✓ ${Object.keys(files).length} generated files match the DU Spec ${SPEC_VERSION}`);
    return;
  }

  const files = buildFromSpec(resolveSpecFiles());
  mkdirSync(OUT_DIR, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(resolve(OUT_DIR, name), contents);
  }
  console.log(`✓ wrote ${Object.keys(files).length} files to ${OUT_REL}/`);
  let ok = runEnumCheckDiff();
  if (!runAssetShapeCheck()) ok = false;
  if (!ok) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`✗ ${error.message}`);
    process.exit(1);
  });
}
