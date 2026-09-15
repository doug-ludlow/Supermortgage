/**
 * Test-only: one of Fannie Mae's eighteen DU Specification Test Case Suite documents as a 23.6 `DuGraph`, and the
 * diff that says whether the emitter reproduced it (23.6 Business rules 7, Open question 1: "test-only, never
 * imported by runtime" — du/emit.test.ts asserts no runtime module imports this file).
 *
 * The loader is the inverse of the emitter and nothing more: every labelled container in the sample becomes a
 * `DuContainer` whose id is the sample's own `xlink:label` and whose position is its place in the document; every
 * `RELATIONSHIP` becomes a `DuArc` between those ids; every data point is typed by its `DU_FORMATS` destination
 * (an amount is parsed to cents so the emitter's rendering is what the round trip proves) and everything no
 * container owns goes to `graph.message`. Comments, whitespace, `SequenceNumber` and the labels themselves are not
 * data — the diff pairs the sample's labels with ours positionally and normalizes whitespace, and nothing else.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { samplePaths } from "../../../infra/integrations/du-schema/index.ts";
import { DU_ARCROLES } from "../du/generated/arcroles.ts";
import { DU_FORMATS } from "../du/generated/lengths.ts";
import type { DuArc, DuCasefileInput, DuContainer, DuContainerKind, DuGraph, DuSubmissionInput, DuValue } from "../du/emit.ts";
import { attr, parseXml, type XmlElement } from "../du/xml.ts";

// The XML reader and the golden diff are runtime modules (src/domain/underwriting/du/xml.ts — the
// diffDuDocumentAgainstSample tool's engine); the tests keep importing them from here.
export { attr, decodeEntities, diffDuDocument, parseXml, type DuDiff, type XmlElement } from "../du/xml.ts";

// ---------------------------------------------------------------------------------------------------------------------
// The sample as a graph

const DEAL = "MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL";
/** The canonical path of each container kind's element — where the loader recognizes one (the emitter's MOUNT table read the other way). */
export const CONTAINER_PATHS: Readonly<Record<string, DuContainerKind>> = {
  [`${DEAL}/ASSETS/ASSET`]: "ASSET",
  [`${DEAL}/LIABILITIES/LIABILITY`]: "LIABILITY",
  [`${DEAL}/EXPENSES/EXPENSE`]: "EXPENSE",
  [`${DEAL}/LOANS/LOAN`]: "LOAN",
  [`${DEAL}/PARTIES/PARTY`]: "PARTY",
  [`${DEAL}/PARTIES/PARTY/ROLES/ROLE`]: "ROLE",
  [`${DEAL}/PARTIES/PARTY/ROLES/ROLE/BORROWER/EMPLOYERS/EMPLOYER`]: "EMPLOYER",
  [`${DEAL}/PARTIES/PARTY/ROLES/ROLE/BORROWER/CURRENT_INCOME/CURRENT_INCOME_ITEMS/CURRENT_INCOME_ITEM`]: "CURRENT_INCOME_ITEM",
  [`${DEAL}/PARTIES/PARTY/ROLES/ROLE/BORROWER/COUNSELING/COUNSELING_EVENTS/COUNSELING_EVENT`]: "COUNSELING_EVENT",
  [`${DEAL}/LOANS/LOAN/EXTENSION/OTHER/DU:LOAN_EXTENSION/DU:UNDERWRITING_VERIFICATIONS/DU:UNDERWRITING_VERIFICATION`]: "UNDERWRITING_VERIFICATION",
};
const AUS_KEY = "UNDERWRITING/AUTOMATED_UNDERWRITINGS/AUTOMATED_UNDERWRITING/AutomatedUnderwritingCaseIdentifier";

/** The value a data point carries in the graph, typed by its DU Map destination: an amount is cents, an indicator a boolean, a count a number, the rest the string DU reads. */
export function typeValue(ownerPath: string, name: string, text: string): DuValue {
  const prefix = `${ownerPath}#${name}#`;
  let kind: string | null = null;
  for (const [key, format] of Object.entries(DU_FORMATS)) if (key.startsWith(prefix) && format) { kind = format.kind; break; }
  if (kind === "amount") { const m = /^(-?)(\d+)\.(\d{2})$/.exec(text); if (m) return BigInt(`${m[1]}${m[2]}${m[3]}`); }
  if (kind === "boolean" && (text === "true" || text === "false")) return text === "true";
  // A number only when the lexical form survives the round trip: MSAIdentifier is Numeric 5 in the workbook but
  // MISMOIdentifier (a string) in the XSD, and DI-FHA04 carries "00720" — the leading zeros are the value.
  if ((kind === "numeric" || kind === "year") && /^-?\d+$/.test(text) && String(Number(text)) === text) return Number(text);
  return text;
}

export interface LoadedSample {
  readonly name: string;
  readonly path: string;
  readonly xml: string;
  readonly graph: DuGraph;
  readonly casefile: DuCasefileInput;
  readonly submission: DuSubmissionInput;
}

/** Container ids the sample's labels; positions the document's order; `application_id` a fixed id for the fixture. */
export function sampleToGraph(root: XmlElement, applicationId = "00000000-0000-4000-8000-00000000d0c5"): { graph: DuGraph; du_casefile_id: string | null } {
  if (root.name !== "MESSAGE") throw new Error(`the root is <${root.name}>, not <MESSAGE>`);
  const containers: DuContainer[] = [];
  const arcs: DuArc[] = [];
  const message: Record<string, DuValue> = {};
  let seq = 0;
  const stamp = (): string => String(++seq).padStart(6, "0");
  let parties = 0;
  let casefileId: string | null = null;

  const readArcs = (rels: XmlElement): void => {
    for (const r of rels.children) {
      if (r.name !== "RELATIONSHIP") throw new Error(`<${r.name}> inside RELATIONSHIPS`);
      const uri = attr(r, "xlink:arcrole") ?? "";
      const name = uri.slice(uri.lastIndexOf("/") + 1);
      if (!DU_ARCROLES[name] || DU_ARCROLES[name]!.arcrole !== uri) throw new Error(`arcrole ${uri} is not in DU_ARCROLES`);
      const from = attr(r, "xlink:from"); const to = attr(r, "xlink:to");
      if (!from || !to) throw new Error("RELATIONSHIP without xlink:from / xlink:to");
      arcs.push({ id: `arc:${arcs.length + 1}`, created_at: stamp(), arcrole: name, from, to });
    }
  };

  /** Flatten `el`'s subtree into `into`, keyed from `keyPrefix`; a nested container becomes its own DuContainer. */
  const flatten = (el: XmlElement, canonical: string, keyPrefix: string, into: Record<string, DuValue>, parentId: string | null, isContainer: boolean): void => {
    for (const [k, v] of el.attrs) {
      if (isContainer && (k === "SequenceNumber" || k === "xlink:label")) continue;
      if (canonical === "MESSAGE") continue; // the root's namespace set and MISMOReferenceModelIdentifier are the emitter's constants
      into[`${keyPrefix}@${k}`] = v;
    }
    const counts = new Map<string, number>();
    for (const c of el.children) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
    const seen = new Map<string, number>();
    for (const c of el.children) {
      const n = (seen.get(c.name) ?? 0) + 1; seen.set(c.name, n);
      const childCanonical = `${canonical}/${c.name}`;
      if (childCanonical === `${DEAL}/RELATIONSHIPS`) { readArcs(c); continue; }
      const kind = CONTAINER_PATHS[childCanonical];
      if (kind) {
        const label = attr(c, "xlink:label");
        const id = kind === "PARTY" ? `PARTY_${++parties}` : label ?? (() => { throw new Error(`${childCanonical} without xlink:label`); })();
        const values: Record<string, DuValue> = {};
        flatten(c, childCanonical, "", values, id, true);
        if (kind === "LOAN" && values[AUS_KEY] !== undefined) { casefileId = String(values[AUS_KEY]); delete values[AUS_KEY]; }
        containers.push({ kind, id, created_at: stamp(), parent: parentId, values });
        continue;
      }
      const step = (counts.get(c.name) ?? 1) > 1 ? `${c.name}[${n}]` : c.name;
      if (c.children.length) { flatten(c, childCanonical, `${keyPrefix}${step}/`, into, parentId, false); continue; }
      if (c.text.trim() === "" && c.attrs.length === 0) throw new Error(`empty element ${childCanonical}`);
      into[`${keyPrefix}${step}`] = typeValue(canonical, c.name, c.text.trim());
      for (const [k, v] of c.attrs) into[`${keyPrefix}${step}/@${k}`] = v;
    }
  };
  flatten(root, "MESSAGE", "", message, null, false);
  const ids = new Set(containers.map((c) => c.id));
  if (ids.size !== containers.length) throw new Error("two containers share a label");
  for (const a of arcs) for (const end of [a.from, a.to]) if (!ids.has(end)) throw new Error(`RELATIONSHIP names ${end}, which no container carries`);
  return { graph: { application_id: applicationId, du_casefile_id: casefileId, message, containers, arcs }, du_casefile_id: casefileId };
}

/** Find a sample by the prefix of its filename (`DI-C09`) and load it. */
export function loadSample(name: string): LoadedSample {
  const matches = samplePaths().filter((p) => basename(p).startsWith(`${name}_`) || basename(p) === name);
  if (matches.length !== 1) throw new Error(`${matches.length} samples match ${JSON.stringify(name)}: ${matches.map((p) => basename(p)).join(", ")}`);
  const path = matches[0]!;
  const xml = readFileSync(path, "utf8");
  const { graph, du_casefile_id } = sampleToGraph(parseXml(xml));
  return {
    name, path, xml, graph,
    casefile: { casefile_id: `casefile:${name}` },
    submission: { submission_number: du_casefile_id === null ? 1 : 2 },
  };
}

/** Every sample's short name, in filename order. */
export function sampleNames(): string[] {
  return samplePaths().map((p) => basename(p).split("_")[0]!);
}
