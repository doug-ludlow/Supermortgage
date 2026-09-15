/**
 * 23.6 — assemble and emit the DU Specification document: MISMO 3.4 Build 324 XML with the DU and ULAD extension
 * namespaces, every container in the child order the XSD sequence dictates, every `xlink:label` unique, every
 * `RELATIONSHIP` arc emitted from the 23.5 graph, every enumerated value one DU accepts.
 *
 * Nothing here is written from memory of MISMO. The serializer writes children in `CHILD_ORDER[type]` from
 * generated/order.ts (a child the table does not list for its parent THROWS — rule 2), checks values against
 * `DU_ENUMERATIONS` (rule 3), widths against `DU_FORMATS` (rule 3), and presence against `DU_CONDITIONALITY`
 * (rule 4); the arcs come from `DU_ARCROLES` and the two `disputed` arcs are never emitted (rule 1, 23.5 Open
 * question 2). The eighteen shipped samples are the golden files (rule 7): src/domain/underwriting/fixtures/
 * du-sample-loader.ts (test-only) parses one into the `DuGraph` below and du/emit.roundtrip.test.ts re-emits it
 * and diffs container by container, arc by arc.
 *
 * The graph the emitter takes is the document's own shape, not the database's: a flat set of containers, each with
 * an identity the labels are assigned from and its data points keyed by XPath relative to the container, plus the
 * arcs between them, plus the deal-level data points no container owns (the subject property, the loan terms).
 * `loadGraph` projects 23.5's `readDuGraph` rows into it; the sample loader projects a sample into it. Two producers,
 * one consumer, and the round trip through the samples is what proves the consumer.
 */
import { createHash } from "node:crypto";
import type { Queryable } from "../../../infra/db/client.ts";
import type { PlainDate } from "../../../kernel/calendar/index.ts";
import { readDuGraph, type DuGraph as DuGraphRows } from "./graph.ts";
import { CHILD_ORDER, TYPE_FOR_PATH } from "./generated/order.ts";
import { DU_ASSET_TYPES_BY_SECTION, DU_ENUMERATIONS } from "./generated/enums.ts";
import { DU_FORMATS, type DuFormat } from "./generated/lengths.ts";
import { DU_CONDITIONALITY, DU_CONDITION_STATEMENTS, type DuCondition, type DuConditionalityEntry } from "./generated/conditionality.ts";
import { DU_ARCROLES, DU_RELATIONSHIP_XPATH } from "./generated/arcroles.ts";
import { parseXml, type XmlElement } from "./xml.ts";
import { decryptTin, tinCipherKey } from "../../../infra/pii/tin.ts";
import { attachmentOf, ESTATE_TYPE_OF_OPTION } from "./property-facts.ts";

// ---------------------------------------------------------------------------------------------------------------------
// The graph

/**
 * A data point's value as the graph carries it. Money is `bigint` cents (rendered `1234.56`, rule 5); a boolean
 * renders `true` / `false`; a count is a `number`; everything else — an enumeration member, a name, a `PlainDate`
 * (`YYYY-MM-DD`), a percent already in DU's lexical form (see `formatPercent`) — is the string DU reads.
 */
export type DuValue = string | bigint | boolean | number | PlainDate;

/**
 * Data points keyed by XPath relative to the element that owns them: `ASSET_DETAIL/AssetType`,
 * `CONTACT_POINTS/CONTACT_POINT[2]/CONTACT_POINT_DETAIL/ContactPointRoleType` (a `[n]` index picks the n-th
 * same-named sibling; absent means the first), `@LoanRoleType` (an attribute of the owner itself).
 */
export type DuValues = Readonly<Record<string, DuValue>>;

/** The ten kinds of labelled container the ArcRoles tab arcs between (PARTY carries the ROLE that is arced to). */
export type DuContainerKind =
  | "ASSET" | "LIABILITY" | "EXPENSE" | "LOAN" | "PARTY" | "ROLE" | "EMPLOYER" | "CURRENT_INCOME_ITEM" | "COUNSELING_EVENT" | "UNDERWRITING_VERIFICATION";

export interface DuContainer {
  readonly kind: DuContainerKind;
  /** The row's id (a uuid from the database; the sample's own label from the loader). Arcs name it. */
  readonly id: string;
  /** Sort key 1 (rule 1: labels are numbered by the row's position in a stable sort on `created_at, id`). */
  readonly created_at: string;
  /** Sorts before `created_at` where the spec fixes a position: DU Borrower 1..4 (`application_borrowers.borrower_ordinal`), the subject loan first. */
  readonly ordinal?: number | null;
  /** The container this one nests in: a ROLE's PARTY; an EMPLOYER's, CURRENT_INCOME_ITEM's or COUNSELING_EVENT's ROLE; an UNDERWRITING_VERIFICATION's LOAN. */
  readonly parent: string | null;
  readonly values: DuValues;
}

export interface DuArc {
  readonly id: string;
  readonly created_at: string;
  /** A key of `DU_ARCROLES` (`ASSET_IsAssociatedWith_ROLE`, …), never a URI typed by hand. */
  readonly arcrole: string;
  /** Container ids. */
  readonly from: string;
  readonly to: string;
}

export interface DuGraph {
  readonly application_id: string;
  /** DU's own casefile identifier (`applications.du_casefile_id`); on the wire only on a resubmission (rule 8). */
  readonly du_casefile_id: string | null;
  /** Data points no container owns, keyed by XPath relative to MESSAGE (`DEAL_SETS/DEAL_SET/DEALS/DEAL/COLLATERALS/COLLATERAL/…`, `ABOUT_VERSIONS/ABOUT_VERSION/CreatedDatetime`). */
  readonly message: DuValues;
  readonly containers: readonly DuContainer[];
  readonly arcs: readonly DuArc[];
}

export interface DuCasefileInput {
  readonly casefile_id: string;
  readonly seller_number?: string | null;
  readonly system_id_ref?: string | null;
}

export interface DuSubmissionInput {
  /** 1 on the first submission; the casefile identifier DU minted goes on the wire from 2 on (rule 8). */
  readonly submission_number: number;
  readonly submission_type?: string;
}

export interface DuDocumentStats {
  readonly container_count: number;
  readonly relationship_count: number;
  readonly borrower_count: number;
  /** Arcs the graph carried whose `DU_ARCROLES` entry is `disputed` — never written, never silent (23.5 Open question 2). */
  readonly disputed_arcs_skipped: number;
}

/** A DU Map requirement the document does not meet (rule 4), recorded when assembled with `conditionality: "report"`. */
export interface DuGap { readonly code: "DU_REQUIRED_MISSING"; readonly xpath: string; readonly detail: string; }

export interface AssembleOptions {
  /**
   * Rule 4 at emission: `refuse` (the default, and the agent's own assembleDuDocument — T5) throws DU_REQUIRED_MISSING
   * at the first required or conditional-true data point with no value; `report` writes the document without the
   * point (never an empty element, never a default) and lists every such gap in `DuDocument.gaps`, so 23.7's preflight
   * gate holds it. Order, enumerations, lengths and arcs are refused under both — a gap is a fact the file lacks, not
   * a document DU would reject on sight. The runtime's 23.1 request builder uses `report` until the borrower flow
   * collects every required point (src/app/tools/section23-1.ts says which).
   */
  readonly conditionality?: "refuse" | "report";
}

export interface DuDocument {
  readonly bytes: Uint8Array;
  /** SHA-256 of `bytes`, hex — the request hash 23.1 carries (rule 6: the hash is the bytes). */
  readonly sha256: string;
  readonly stats: DuDocumentStats;
  readonly labels: ReadonlyMap<string, string>;
  /** Empty under `conditionality: "refuse"`; the required / conditional points absent from the file under `report`. */
  readonly gaps: readonly DuGap[];
}

/** A refusal, naming the XPath (23.6 Business rules 2–4 and 8). */
export class DuEmitError extends Error {
  readonly code: string;
  readonly xpath: string;
  readonly detail: string;
  constructor(code: string, xpath: string, detail: string) {
    super(`${code}: ${xpath}${detail ? ` — ${detail}` : ""}`);
    this.name = "DuEmitError";
    this.code = code;
    this.xpath = xpath;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Constants read from the corpus, not typed from memory

/** The root element's attributes, verbatim from DI-C01's `<MESSAGE …>` (samples/DI-C01_DU Spec 1.9.1_Fixed Primary Attchd.xml, line 2), in that order. */
export const DU_ROOT_ATTRIBUTES: readonly (readonly [string, string])[] = [
  ["xmlns", "http://www.mismo.org/residential/2009/schemas"],
  ["xmlns:xsi", "http://www.w3.org/2001/XMLSchema-instance"],
  ["xmlns:ULAD", "http://www.datamodelextension.org/Schema/ULAD"],
  ["xmlns:DU", "http://www.datamodelextension.org/Schema/DU"],
  ["MISMOReferenceModelIdentifier", "3.4.032420160128"],
  ["xmlns:xlink", "http://www.w3.org/1999/xlink"],
  ["xsi:schemaLocation", "http://www.mismo.org/residential/2009/schemas DU_Wrapper_3.4.0_B324.xsd"],
];

/** The DU Specification the six generated tables were derived from (tools/build-du.mjs `SPEC_VERSION`) and the MISMO build of the vendored chain — `du_documents.spec_version` / `mismo_build`. */
export const DU_SPEC_VERSION = "1.9.3";
export const DU_MISMO_BUILD = "B324";
/** What `loadGraph` writes as `AboutVersionIdentifier`: the specification the tables were generated from. */
export const DU_ABOUT_VERSION_IDENTIFIER = `DU Spec ${DU_SPEC_VERSION}`;

const DEAL = "MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL";

/** Where each kind mounts: the path from its parent element (MESSAGE for a top-level kind) to the container element, and what it is labelled. */
const MOUNT: Readonly<Record<DuContainerKind, { readonly parentKind: DuContainerKind | null; readonly path: string; readonly label: string; readonly sequenceNumber: boolean }>> = {
  ASSET: { parentKind: null, path: "DEAL_SETS/DEAL_SET/DEALS/DEAL/ASSETS/ASSET", label: "ASSET", sequenceNumber: true },
  LIABILITY: { parentKind: null, path: "DEAL_SETS/DEAL_SET/DEALS/DEAL/LIABILITIES/LIABILITY", label: "LIABILITY", sequenceNumber: true },
  EXPENSE: { parentKind: null, path: "DEAL_SETS/DEAL_SET/DEALS/DEAL/EXPENSES/EXPENSE", label: "EXPENSE", sequenceNumber: true },
  LOAN: { parentKind: null, path: "DEAL_SETS/DEAL_SET/DEALS/DEAL/LOANS/LOAN", label: "LOAN", sequenceNumber: false },
  PARTY: { parentKind: null, path: "DEAL_SETS/DEAL_SET/DEALS/DEAL/PARTIES/PARTY", label: "", sequenceNumber: false },
  ROLE: { parentKind: "PARTY", path: "ROLES/ROLE", label: "", sequenceNumber: true },
  EMPLOYER: { parentKind: "ROLE", path: "BORROWER/EMPLOYERS/EMPLOYER", label: "EMPLOYER", sequenceNumber: true },
  CURRENT_INCOME_ITEM: { parentKind: "ROLE", path: "BORROWER/CURRENT_INCOME/CURRENT_INCOME_ITEMS/CURRENT_INCOME_ITEM", label: "CURRENT_INCOME_ITEM", sequenceNumber: true },
  COUNSELING_EVENT: { parentKind: "ROLE", path: "BORROWER/COUNSELING/COUNSELING_EVENTS/COUNSELING_EVENT", label: "COUNSELING_EVENT", sequenceNumber: true },
  UNDERWRITING_VERIFICATION: { parentKind: "LOAN", path: "EXTENSION/OTHER/DU:LOAN_EXTENSION/DU:UNDERWRITING_VERIFICATIONS/DU:UNDERWRITING_VERIFICATION", label: "UNDERWRITING_VERIFICATION", sequenceNumber: true },
};
const KIND_ORDER: readonly DuContainerKind[] = ["ASSET", "LIABILITY", "EXPENSE", "LOAN", "PARTY", "ROLE", "EMPLOYER", "CURRENT_INCOME_ITEM", "COUNSELING_EVENT", "UNDERWRITING_VERIFICATION"];
/** The canonical path of each container kind's element (MESSAGE-rooted; MOUNT read the other way) — what 23.7's preflight recognizes a container by. */
export const DU_CONTAINER_PATHS: Readonly<Record<string, DuContainerKind>> = Object.fromEntries(KIND_ORDER.map((kind) => {
  const parts: string[] = [];
  for (let k: DuContainerKind | null = kind; k !== null; k = MOUNT[k].parentKind) parts.unshift(MOUNT[k].path);
  return [`MESSAGE/${parts.join("/")}`, kind];
})) as Readonly<Record<string, DuContainerKind>>;

/**
 * Which DU enumeration governs a data point, by name and — where one name is filed under several form fields with
 * different member sets — by the DU Map form field the destination is filed under (an empty list: every destination).
 * This is tools/build-du.mjs `DU_DATA_POINT_FOR_ENUM` restated for the emitter (du/emit.test.ts asserts the two
 * agree, so a change to the generator's mapping fails here); `also` is the generator's `exclude`: a member DU accepts
 * for the data point that the Du* enum (a du_* column's CHECK) leaves out — `Borrower` has its own container.
 */
export const DU_ENUM_FOR_DATA_POINT: readonly { readonly enumeration: string; readonly dataPoint: string; readonly formFields: readonly string[]; readonly also?: readonly string[] }[] = [
  { enumeration: "DuYesNo", dataPoint: "IntentToOccupyType", formFields: ["5a.1"] },
  { enumeration: "DuYesNo", dataPoint: "HomeownerPastThreeYearsType", formFields: ["5a.1.1"] },
  { enumeration: "DuPriorPropertyTitle", dataPoint: "PriorPropertyTitleType", formFields: ["5a.1.3"] },
  { enumeration: "DuBankruptcyChapter", dataPoint: "BankruptcyChapterType", formFields: ["5b.8.1"] },
  { enumeration: "DuResidencyBasis", dataPoint: "BorrowerResidencyBasisType", formFields: ["1a.14.1", "1a.16.1"] },
  { enumeration: "DuResidencyType", dataPoint: "BorrowerResidencyType", formFields: ["1a.13", "1a.15"] },
  { enumeration: "DuAssetType", dataPoint: "AssetType", formFields: [] },
  { enumeration: "DuAssetTypeOtherDescription", dataPoint: "AssetTypeOtherDescription", formFields: ["2b.1"] },
  { enumeration: "DuLiabilityType", dataPoint: "LiabilityType", formFields: ["2c.1", "3a.11"] },
  { enumeration: "DuLiabilityMortgageType", dataPoint: "MortgageType", formFields: ["3a.14"] },
  { enumeration: "DuExpenseType", dataPoint: "ExpenseType", formFields: ["2d.1"] },
  { enumeration: "DuOwnedPropertyDisposition", dataPoint: "OwnedPropertyDispositionStatusType", formFields: ["3a.4"] },
  { enumeration: "DuPropertyUsage", dataPoint: "PropertyCurrentUsageType", formFields: [] },
  { enumeration: "DuPropertyUsage", dataPoint: "PriorPropertyUsageType", formFields: ["5a.1.2"] },
  { enumeration: "DuIntendedPropertyUsage", dataPoint: "PropertyUsageType", formFields: ["3a.5"] },
  { enumeration: "DuPropertyUsageOtherDescription", dataPoint: "PropertyUsageTypeOtherDescription", formFields: [] },
  { enumeration: "DuFundsSourceType", dataPoint: "FundsSourceType", formFields: ["4d.3"] },
  { enumeration: "DuPropertyOwnerStatus", dataPoint: "PropertyOwnerStatusType", formFields: ["L2.1", "L2.2"] },
  { enumeration: "DuVestingType", dataPoint: "RelationshipVestingType", formFields: ["L2.4"] },
  { enumeration: "DuLicenseAuthorityLevel", dataPoint: "LicenseAuthorityLevelType", formFields: ["9.3", "9.4", "9.6", "9.7"] },
  { enumeration: "DuDealPartyRole", dataPoint: "PartyRoleType", formFields: [], also: ["Borrower"] },
  { enumeration: "DuVerificationReportType", dataPoint: "DU:VerificationReportType", formFields: [""] },
];

// ---------------------------------------------------------------------------------------------------------------------
// Rendering values (rule 5)

/** `bigint` cents → MISMOAmount: two places, a leading minus for a negative net (DI-C08 emits -678.00). */
export function formatAmountCents(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const whole = abs / 100n;
  const frac = abs % 100n;
  return `${negative ? "-" : ""}${whole}.${frac < 10n ? "0" : ""}${frac}`;
}

/**
 * A percent in DU's lexical form for a destination whose `DU_FORMATS` entry allows `decimals` places: the value is
 * given as a plain decimal string of the percentage (`"5.25"`, not the rate `0.0525`) and is written with the places
 * it has, never rounded here (rule 5: the kernel's Decimal did that upstream) — more places than the format admits
 * is refused as `DU_LENGTH`.
 */
export function formatPercent(percent: string, format: DuFormat, xpath = "percent"): string {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(percent);
  if (!m) throw new DuEmitError("DU_LENGTH", xpath, `${JSON.stringify(percent)} is not a decimal percent`);
  const decimals = format.decimals ?? 0;
  const frac = m[3] ?? "";
  if (frac.length > decimals) throw new DuEmitError("DU_LENGTH", xpath, `${percent} has ${frac.length} decimal places; the format admits ${decimals}`);
  return percent;
}

/** A `PlainDate` is already `YYYY-MM-DD`; this is the one place the type is stated for the reader. */
export function formatDate(date: PlainDate): string { return date; }

export function renderValue(value: DuValue): string {
  switch (typeof value) {
    case "bigint": return formatAmountCents(value);
    case "boolean": return value ? "true" : "false";
    case "number": return Number.isInteger(value) ? String(value) : String(value);
    default: return value;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The in-memory tree

interface Node {
  readonly name: string;
  readonly parent: Node | null;
  readonly attrs: Map<string, string>;
  readonly children: Node[];
  text: string | null;
}

const node = (name: string, parent: Node | null): Node => ({ name, parent, attrs: new Map(), children: [], text: null });

const SEGMENT = /^(@?[A-Za-z_][\w.:-]*)(?:\[(\d+)\])?$/;

/** Path of a node from the root, `[n]` on a child that has same-named siblings. */
function instancePath(n: Node): string {
  const parts: string[] = [];
  for (let cur: Node | null = n; cur; cur = cur.parent) {
    const p = cur.parent;
    if (p) {
      const siblings = p.children.filter((c) => c.name === cur!.name);
      parts.unshift(siblings.length > 1 ? `${cur.name}[${siblings.indexOf(cur) + 1}]` : cur.name);
    } else parts.unshift(cur.name);
  }
  return parts.join("/");
}

/** Path of a node from the root with no indices: the key `TYPE_FOR_PATH`, `DU_FORMATS` and `DU_CONDITIONALITY` use. */
function canonicalPath(n: Node): string {
  const parts: string[] = [];
  for (let cur: Node | null = n; cur; cur = cur.parent) parts.unshift(cur.name);
  return parts.join("/");
}

/** The n-th child named `name`, created (with any missing earlier siblings) when absent. */
function childAt(parent: Node, name: string, index: number): Node {
  const same = parent.children.filter((c) => c.name === name);
  while (same.length < index) { const c = node(name, parent); parent.children.push(c); same.push(c); }
  return same[index - 1]!;
}

function place(owner: Node, relPath: string, value: DuValue): void {
  const segments = relPath.split("/");
  let cur = owner;
  for (let i = 0; i < segments.length; i++) {
    const m = SEGMENT.exec(segments[i]!);
    if (!m) throw new DuEmitError("DU_BAD_PATH", `${instancePath(owner)}/${relPath}`, `segment ${JSON.stringify(segments[i])} is not an element step`);
    const name = m[1]!;
    const last = i === segments.length - 1;
    if (name.startsWith("@")) {
      if (!last) throw new DuEmitError("DU_BAD_PATH", `${instancePath(owner)}/${relPath}`, "an attribute step must be the last");
      const attr = name.slice(1);
      if (cur.attrs.has(attr)) throw new DuEmitError("DU_DUPLICATE_VALUE", `${instancePath(cur)}/@${attr}`, "written twice");
      cur.attrs.set(attr, renderValue(value));
      return;
    }
    const next = childAt(cur, name, m[2] ? Number(m[2]) : 1);
    if (last) {
      if (next.children.length) throw new DuEmitError("DU_BAD_PATH", instancePath(next), "a data point cannot also be a container");
      if (next.text !== null) throw new DuEmitError("DU_DUPLICATE_VALUE", instancePath(next), "written twice");
      next.text = renderValue(value);
      return;
    }
    if (next.text !== null) throw new DuEmitError("DU_BAD_PATH", instancePath(next), "a data point cannot also be a container");
    cur = next;
  }
}

/** A fresh container element appended under `owner` at `path` (intermediate steps are shared, the last is always new). */
function mount(owner: Node, path: string): Node {
  const segments = path.split("/");
  let cur = owner;
  for (let i = 0; i < segments.length - 1; i++) cur = childAt(cur, segments[i]!, 1);
  const fresh = node(segments[segments.length - 1]!, cur);
  cur.children.push(fresh);
  return fresh;
}

// ---------------------------------------------------------------------------------------------------------------------
// Types and order (rule 2)

/** The complex type of a child element, from the generated tables — or null when the child is a data point (a leaf). */
function typeOfChild(parentPath: string, parentType: string, child: Node): string | null {
  const path = `${parentPath}/${child.name}`;
  const byPath = TYPE_FOR_PATH[path];
  if (byPath) return byPath;
  // The graph's own container: DEAL lists it, order.ts has no sequence for it (its children are RELATIONSHIP elements
  // alone, written by the assembly, never by a value) — DU_RELATIONSHIP_XPATH is the one XPath the arcs live in.
  if (child.name === "RELATIONSHIPS" && `${path}/RELATIONSHIP` === DU_RELATIONSHIP_XPATH) return "RELATIONSHIPS";
  if (child.name === "EXTENSION" && CHILD_ORDER[`${parentType}_EXTENSION`]) return `${parentType}_EXTENSION`;
  if (child.name === "OTHER" && parentType.endsWith("_EXTENSION") && CHILD_ORDER[`${parentType}/OTHER`]) return `${parentType}/OTHER`;
  if (CHILD_ORDER[child.name]) return child.name;
  if (child.children.length) throw new DuEmitError("DU_CHILD_NOT_IN_ORDER", instancePath(child), `${child.name} is not a container the generated tables know under ${parentType}`);
  return null;
}

interface Leaf { readonly owner: Node; readonly ownerPath: string; readonly name: string; readonly value: string; readonly xpath: string; }

/** Walk the tree in schema order, refusing a child the parent's sequence does not list; collect every data point. */
function walk(n: Node, path: string, type: string, leaves: Leaf[]): void {
  for (const [attr, value] of n.attrs) {
    if (attr.startsWith("xmlns") || attr.startsWith("xsi:") || attr.startsWith("xlink:")) continue;
    leaves.push({ owner: n, ownerPath: path, name: attr, value, xpath: `${instancePath(n)}/@${attr}` });
  }
  if (n.name === "RELATIONSHIPS") {
    for (const c of n.children) if (c.name !== "RELATIONSHIP" || c.children.length || c.text !== null) throw new DuEmitError("DU_CHILD_NOT_IN_ORDER", instancePath(c), "RELATIONSHIPS carries RELATIONSHIP elements only");
    return;
  }
  const order = CHILD_ORDER[type];
  if (!order) throw new DuEmitError("DU_CHILD_NOT_IN_ORDER", instancePath(n), `no child sequence for type ${type}`);
  for (const c of n.children) {
    if (!order.includes(c.name)) throw new DuEmitError("DU_CHILD_NOT_IN_ORDER", instancePath(c), `${c.name} is not in the ${type} sequence [${order.join(", ")}]`);
    const childType = typeOfChild(path, type, c);
    if (childType === null) {
      leaves.push({ owner: n, ownerPath: path, name: c.name, value: c.text ?? "", xpath: instancePath(c) });
      if (c.text === null) throw new DuEmitError("DU_REQUIRED_MISSING", instancePath(c), "an empty element is not a value");
      continue;
    }
    walk(c, `${path}/${c.name}`, childType, leaves);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Values (rule 3): enumerations and formats

function formatsFor(ownerPath: string, name: string): { readonly formField: string; readonly format: DuFormat | null }[] {
  const prefix = `${ownerPath}#${name}#`;
  const out: { formField: string; format: DuFormat | null }[] = [];
  for (const [key, format] of Object.entries(DU_FORMATS)) if (key.startsWith(prefix)) out.push({ formField: key.slice(prefix.length), format });
  return out;
}

function checkEnumeration(leaf: Leaf): void {
  const formFields = formatsFor(leaf.ownerPath, leaf.name).map((f) => f.formField);
  for (const row of DU_ENUM_FOR_DATA_POINT) {
    if (row.dataPoint !== leaf.name) continue;
    if (row.formFields.length && !row.formFields.some((ff) => formFields.includes(ff))) continue;
    const members = DU_ENUMERATIONS[row.enumeration];
    if (!members) throw new Error(`DU_ENUMERATIONS has no ${row.enumeration}`);
    const admitted = [...members, ...(row.also ?? [])];
    if (!admitted.includes(leaf.value)) throw new DuEmitError("DU_ENUM_NOT_SUPPORTED", leaf.xpath, `${JSON.stringify(leaf.value)} is not a member of ${row.enumeration}; DU admits ${admitted.join(", ")}`);
  }
}

function checkFormat(leaf: Leaf): void {
  const formats = formatsFor(leaf.ownerPath, leaf.name).map((f) => f.format).filter((f): f is DuFormat => f !== null);
  if (!formats.length) return;
  const kinds = new Set(formats.map((f) => f.kind));
  const v = leaf.value;
  const refuse = (detail: string): never => { throw new DuEmitError("DU_LENGTH", leaf.xpath, detail); };
  if (kinds.has("string")) {
    const max = Math.max(...formats.map((f) => f.maxLength ?? Infinity));
    if (Number.isFinite(max) && [...v].length > max) refuse(`${[...v].length} characters; the format admits ${max}`);
  }
  if (kinds.has("numeric") || kinds.has("year")) {
    const m = /^-?(\d+)$/.exec(v);
    if (!m) refuse(`${JSON.stringify(v)} is not a whole number`);
    const digits = Math.max(...formats.map((f) => f.digits ?? (f.kind === "year" ? 4 : Infinity)));
    if (Number.isFinite(digits) && m![1]!.length > digits) refuse(`${m![1]!.length} digits; the format admits ${digits}`);
  }
  if (kinds.has("amount") || kinds.has("percent")) {
    const m = /^-?(\d+)(?:\.(\d+))?$/.exec(v);
    if (!m) refuse(`${JSON.stringify(v)} is not a decimal`);
    const digits = Math.max(...formats.map((f) => f.digits ?? Infinity));
    const decimals = Math.max(...formats.map((f) => f.decimals ?? 0));
    if (m![1]!.length > digits) refuse(`${m![1]!.length} integer digits; the format admits ${digits}`);
    if ((m![2] ?? "").length > decimals) refuse(`${(m![2] ?? "").length} decimal places; the format admits ${decimals}`);
  }
  if (kinds.has("date") && !/^\d{4}-\d{2}-\d{2}$/.test(v)) refuse(`${JSON.stringify(v)} is not a MISMODate (YYYY-MM-DD)`);
  if (kinds.has("boolean") && v !== "true" && v !== "false") refuse(`${JSON.stringify(v)} is not a MISMOIndicator (true | false)`);
}

// ---------------------------------------------------------------------------------------------------------------------
// Conditionality (rule 4)

/**
 * The DU Map states each requirement for a form field, and files one data point under several: `LiabilityType` is
 * "IF LiabilityUnpaidBalanceAmount exists" at 2c.1 (a credit card) and "IF … OR HELOCMaximumBalanceAmount exists"
 * at 3a.11 (a mortgage on an owned property); `AddressLineText` is required at 1a.13.1 (the current residence) and
 * "IF Prior AND exists" at 1a.15.1; `FirstName` is required at 1a.1.1 (a borrower) and optional at 9.5 (the loan
 * originator). A filing binds an instance only when the instance is that form field's, and the samples say which
 * readings are wrong: DI-C09's mortgage liability carries no LiabilityRemainingTermMonthsCount (2c.7) and DI-C01's
 * credit card no LiabilityPaymentIncludesTaxesInsuranceIndicator (3a.15), and both are valid documents. So each
 * element on the way from the entry's container up to its scope may narrow the form fields that bind it, from what
 * the element itself says: a PARTY by its PartyRoleType, a LOAN by its LoanRoleType, an ASSET by its AssetType's
 * URLA section (DU_ASSET_TYPES_BY_SECTION) or its OWNED_PROPERTY, a LIABILITY by whether its type is a mortgage,
 * a RESIDENCE by Current / Prior, an EMPLOYER by Current / Previous, a CURRENT_INCOME_ITEM by
 * EmploymentIncomeIndicator. A row with no form field binds every instance.
 */
const PARTY_SECTIONS: Readonly<Record<string, readonly string[]>> = {
  Borrower: ["1", "5", "6", "7", "8", "SC"],
  NotePayTo: ["4b"],
  LoanOriginationCompany: ["9"],
  LoanOriginator: ["9"],
  PropertyOwner: ["L2"],
  Trust: ["L2"],
  HousingCounselingAgency: ["SC"],
  SubmittingParty: [],
};
const MORTGAGE_LIABILITY_TYPES: readonly string[] = ["MortgageLoan", "HELOC"];

function bindsFormField(n: Node): ((ff: string) => boolean) | null {
  const first = (name: string): string | undefined => collect(n, name)[0];
  switch (n.name) {
    case "PARTY": {
      const prefixes = collect(n, "PartyRoleType").flatMap((r) => PARTY_SECTIONS[r] ?? []);
      return (ff) => prefixes.some((p) => ff.startsWith(p));
    }
    case "LOAN": {
      const role = n.attrs.get("LoanRoleType");
      if (role === "SubjectLoan") return (ff) => !ff.startsWith("4b");
      if (role === "RelatedLoan") return (ff) => ff.startsWith("4b");
      return null;
    }
    case "ASSET": {
      if (n.children.some((c) => c.name === "OWNED_PROPERTY")) return (ff) => ff.startsWith("3a");
      const type = first("AssetType");
      const section = type === undefined ? undefined : Object.entries(DU_ASSET_TYPES_BY_SECTION).find(([, members]) => members.includes(type))?.[0]?.split(".")[0];
      return section === undefined ? null : (ff) => ff.startsWith(section);
    }
    case "LIABILITY": {
      const type = first("LiabilityType");
      if (type === undefined) return null;
      return MORTGAGE_LIABILITY_TYPES.includes(type) ? (ff) => ff.startsWith("3a") : (ff) => !ff.startsWith("3a");
    }
    case "RESIDENCE": {
      const type = first("BorrowerResidencyType");
      if (type === "Current") return (ff) => !/^1a\.1[56]\b/.test(ff);
      if (type === "Prior") return (ff) => !/^1a\.1[34]\b/.test(ff);
      return null;
    }
    case "EMPLOYER": {
      const status = first("EmploymentStatusType");
      if (status === "Current") return (ff) => !ff.startsWith("1d");
      if (status === "Previous") return (ff) => !/^1[bc]/.test(ff);
      return null;
    }
    case "CURRENT_INCOME_ITEM": {
      const employment = first("EmploymentIncomeIndicator");
      if (employment === "true") return (ff) => !ff.startsWith("1e");
      if (employment === "false") return (ff) => !ff.startsWith("1b");
      return null;
    }
    default: return null;
  }
}

/**
 * DU Map rows whose form-field column the generator read as empty but which the samples file under one URLA section
 * and one only. A row with no form field binds every instance, and for these that reading is wrong — each is cited
 * against the corpus (tools: `python3 - <<EOF` over samples/, counting per LiabilityType), never against memory:
 * - `LiabilityRemainingTermMonthsCount` (URLA 2c.7 "Months Left to Pay"): every Installment (30) and Revolving (57)
 *   liability in the eighteen samples carries it; no MortgageLoan (22) or HELOC (1) does, and every sample is a
 *   document DU accepted. The count is a 2c point; a mortgage liability (3a) is not bound.
 */
const FORM_FIELD_OVERRIDES: Readonly<Record<string, string>> = {
  [`${DEAL}/LIABILITIES/LIABILITY/LIABILITY_DETAIL#LiabilityRemainingTermMonthsCount`]: "2c.7",
};

/**
 * DU Map rows whose condition statement the corpus shows DU does not enforce: each names a data point the eighteen
 * accepted samples omit while its statement holds, so a refusal here would refuse documents DU accepted (rule 7 —
 * the golden files are the arbiter). Cited against the corpus (`python3` over samples/, per EMPLOYER), never memory:
 * - `DU:ForeignIncomeIndicator` and `DU:SeasonalIncomeIndicator` ("IF EmploymentStatusType = Current"): 13 of the 31
 *   Current employers carry no DU:EMPLOYMENT_EXTENSION at all — DI-C06's self-employed EMPLOYER_2, DI-FHA01's first
 *   employer, every employer in DI-FHA02, DI-FHA03, DI-FHA04, DI-VA01, DI-VA02, DI-VA03 and DI-VA04 — with no
 *   correlation to self-employment, ownership share or loan type (DI-C02 and DI-CL01 carry it on the same shape).
 *   Both indicators are optional in practice; a value, when present, is still checked as a leaf.
 * - `ULAD:SpecialBorrowerSellerRelationshipIndicator` (URLA 5a.2, "IF LoanPurposeType = Purchase"): the corpus has
 *   sixteen borrowers on Purchase loans (DI-C01, DI-C02 ×3, DI-C07, DI-C08 ×2, DI-CL01, DI-FHA01 ×2, DI-FHA03,
 *   DI-VA01, DI-VA02 ×2, DI-VA03 ×2) and fifteen carry it; DI-FHA01's second borrower carries no
 *   ULAD:DECLARATION_DETAIL_EXTENSION at all while its first does, on the same deal, and the document was accepted.
 *   Nothing on that borrower distinguishes it (same declaration answers, same role, same loan); the indicator is
 *   optional in practice.
 */
const CORPUS_OPTIONAL: ReadonlySet<string> = new Set([
  `${DEAL}/PARTIES/PARTY/ROLES/ROLE/BORROWER/EMPLOYERS/EMPLOYER/EMPLOYMENT/EXTENSION/OTHER/DU:EMPLOYMENT_EXTENSION#DU:ForeignIncomeIndicator`,
  `${DEAL}/PARTIES/PARTY/ROLES/ROLE/BORROWER/EMPLOYERS/EMPLOYER/EMPLOYMENT/EXTENSION/OTHER/DU:EMPLOYMENT_EXTENSION#DU:SeasonalIncomeIndicator`,
  `${DEAL}/PARTIES/PARTY/ROLES/ROLE/BORROWER/DECLARATION/DECLARATION_DETAIL/EXTENSION/OTHER/ULAD:DECLARATION_DETAIL_EXTENSION#ULAD:SpecialBorrowerSellerRelationshipIndicator`,
]);

/**
 * DU Map rows the corpus shows are not bound on a particular instance — narrower than CORPUS_OPTIONAL, which drops a
 * row everywhere: here the requirement stands wherever the samples honour it and is released only where every sample
 * of that shape omits it. Keyed like CORPUS_OPTIONAL; the predicate sees the entry's scope root (the LOAN, PARTY,
 * ASSET … the point sits under). Cited against the corpus (`python3` over samples/, per LOAN by LoanRoleType and
 * TERMS_OF_LOAN/MortgageType), never memory:
 * - `BuydownTemporarySubsidyFundingIndicator` (URLA L3.12, "required"): every Conventional and FHA subject loan in
 *   the eighteen samples carries it (14 of 14: DI-C01–C09, DI-CL01, DI-FHA01–FHA04) and no VA subject loan does
 *   (0 of 4: DI-VA01, DI-VA02, DI-VA03, DI-VA04), all four accepted. No RelatedLoan carries it (LOAN's own binding
 *   already excludes 4b's loans). A VA subject loan is not bound; a value, when present, is still checked as a leaf.
 * - `PropertyExistingCleanEnergyLienIndicator` (URLA L1.10, "required"): seventeen of the eighteen samples carry it
 *   on the subject property — every Conventional loan (10), every FHA loan (4) and every VA Purchase (DI-VA01,
 *   DI-VA02, DI-VA03). The one VA Refinance, DI-VA04, carries none (its SUBJECT_PROPERTY/PROPERTY_DETAIL runs
 *   PropertyEstateType → PropertyInProjectIndicator, line 100–101) and was accepted. The predicate sees the
 *   COLLATERAL; the subject loan's MortgageType and LoanPurposeType are read from the deal it sits in. A VA
 *   refinance's subject property is not bound; a value, when present, is still checked as a leaf.
 */
const CORPUS_UNBOUND: Readonly<Record<string, (scope: Node, deal: DealContext) => boolean>> = {
  [`${DEAL}/LOANS/LOAN/LOAN_DETAIL#BuydownTemporarySubsidyFundingIndicator`]: (scope) => scope.name === "LOAN" && collect(scope, "MortgageType")[0] === "VA",
  [`${DEAL}/COLLATERALS/COLLATERAL/SUBJECT_PROPERTY/PROPERTY_DETAIL#PropertyExistingCleanEnergyLienIndicator`]: (scope, deal) =>
    scope.name === "COLLATERAL" && deal.subjectLoans.some((l) => collect(l, "MortgageType")[0] === "VA" && collect(l, "LoanPurposeType")[0] === "Refinance"),
};

/** Does the DU Map row bind the instance at `at` (the entry's container, or the deepest ancestor present)? */
function entryBinds(entry: DuConditionalityEntry, at: Node, scope: Node): boolean {
  const formFieldId = entry.formFieldId || FORM_FIELD_OVERRIDES[`${entry.xpath}#${entry.name}`] || "";
  const fields = formFieldId.split("|").map((f) => f.trim()).filter(Boolean);
  if (!fields.length) return true;
  for (let cur: Node | null = at; cur; cur = cur.parent) {
    const accepts = bindsFormField(cur);
    if (accepts && !fields.some(accepts)) return false;
    if (cur === scope) break;
  }
  return true;
}

const SCOPE_ROOTS = [`${DEAL}/PARTIES/PARTY`, `${DEAL}/LOANS/LOAN`, `${DEAL}/COLLATERALS/COLLATERAL`, `${DEAL}/ASSETS/ASSET`, `${DEAL}/LIABILITIES/LIABILITY`, `${DEAL}/EXPENSES/EXPENSE`, "MESSAGE/DEAL_SETS/PARTIES/PARTY"];

/** Every node reached by following `steps` (element names) from `from`, fanning out over same-named siblings; `deepest` is the last node any branch reached. */
function resolve(from: Node, steps: readonly string[]): { nodes: Node[]; deepest: Node } {
  let frontier = [from];
  let deepest = from;
  for (const step of steps) {
    const next: Node[] = [];
    for (const n of frontier) for (const c of n.children) if (c.name === step) next.push(c);
    if (!next.length) return { nodes: [], deepest };
    frontier = next;
    deepest = next[0]!;
  }
  return { nodes: frontier, deepest };
}

/** Every value of the data point `name` in `n`'s subtree (its own attributes included). */
function collect(n: Node, name: string): string[] {
  const out: string[] = [];
  const visit = (cur: Node): void => {
    const attr = cur.attrs.get(name);
    if (attr !== undefined) out.push(attr);
    for (const c of cur.children) {
      if (c.name === name && c.text !== null) out.push(c.text);
      visit(c);
    }
  };
  visit(n);
  return out;
}

interface DealContext { readonly subjectLoans: readonly Node[]; readonly collaterals: readonly Node[]; }

/**
 * The values a condition's data point takes for the point being checked: nearest scope first — the container the
 * point sits in, then each ancestor up to the scope root (a borrower's own EmploymentStatusType, not a sibling
 * employer's) — then the deal-level facts every party may be conditioned on (LoanPurposeType on the subject loan,
 * PropertyUsageType and FinancedUnitCount on the collateral). Never another party: `PartyRoleType = "Borrower"`
 * asked from inside a LOAN is false, not "somebody on this deal is a borrower".
 */
function lookup(name: string, start: Node, scopeRoot: Node, deal: DealContext): string[] {
  for (let cur: Node | null = start; cur; cur = cur.parent) {
    const found = collect(cur, name);
    if (found.length) return found;
    if (cur === scopeRoot) break;
  }
  // A LOAN's facts are its own: DI-C09's RelatedLoan carries no PURCHASE_CREDIT, and "IF PurchaseCreditAmount exists"
  // asked from inside it must not find the subject loan's. Only a point outside every LOAN reads the subject loan.
  if (scopeRoot.name !== "LOAN") for (const loan of deal.subjectLoans) { const found = collect(loan, name); if (found.length) return found; }
  for (const col of deal.collaterals) { const found = collect(col, name); if (found.length) return found; }
  return [];
}

function compare(actual: readonly string[], operator: string, value: string | number): boolean {
  if (operator === "<>") return !actual.some((a) => a === String(value));
  return actual.some((a) => {
    if (typeof value === "number") {
      const n = Number(a);
      if (!Number.isFinite(n)) return false;
      switch (operator) { case "=": return n === value; case "<": return n < value; case ">": return n > value; case "<=": return n <= value; case ">=": return n >= value; default: throw new Error(`unknown operator ${operator}`); }
    }
    if (operator === "=") return a === value;
    throw new Error(`unknown operator ${operator} for ${JSON.stringify(value)}`);
  });
}

/** Is the (absent) data point required? `self_exists` is the point's own presence and it is absent by hypothesis, so it is false. */
function holds(cond: DuCondition, at: Node, scopeRoot: Node, deal: DealContext): boolean {
  switch (cond.kind) {
    case "self_exists": return false;
    case "exists": return lookup(cond.dataPoint, at, scopeRoot, deal).length > 0;
    case "absent": return lookup(cond.dataPoint, at, scopeRoot, deal).length === 0;
    case "compare": return compare(lookup(cond.dataPoint, at, scopeRoot, deal), cond.operator, cond.value);
    case "in": { const actual = lookup(cond.dataPoint, at, scopeRoot, deal); return cond.values.some((v) => actual.includes(v)); }
    case "and": return cond.terms.every((t) => holds(t, at, scopeRoot, deal));
    case "or": return cond.terms.some((t) => holds(t, at, scopeRoot, deal));
  }
}

function checkConditionality(root: Node, mode: "refuse" | "report"): DuGap[] {
  const gaps: DuGap[] = [];
  const dealNodes = resolve(root, DEAL.split("/").slice(1)).nodes;
  const deal: DealContext = {
    subjectLoans: dealNodes.flatMap((d) => resolve(d, ["LOANS", "LOAN"]).nodes).filter((l) => l.attrs.get("LoanRoleType") === "SubjectLoan"),
    collaterals: dealNodes.flatMap((d) => resolve(d, ["COLLATERALS", "COLLATERAL"]).nodes),
  };
  for (const entry of DU_CONDITIONALITY) {
    if (entry.requirement !== "required" && entry.requirement !== "conditional") continue;
    if (CORPUS_OPTIONAL.has(`${entry.xpath}#${entry.name}`)) continue;
    const scopePath = SCOPE_ROOTS.find((s) => entry.xpath === s || entry.xpath.startsWith(`${s}/`)) ?? "MESSAGE";
    const scopes = scopePath === "MESSAGE" ? [root] : resolve(root, scopePath.split("/").slice(1)).nodes;
    const rel = entry.xpath === scopePath ? [] : entry.xpath.slice(scopePath.length + 1).split("/");
    const condition = entry.condition === null ? null : DU_CONDITION_STATEMENTS[entry.condition];
    if (entry.requirement === "conditional" && !condition) continue; // a statement the generator could not parse: the preflight's (UNPARSEABLE_STATEMENTS)
    const unbound = CORPUS_UNBOUND[`${entry.xpath}#${entry.name}`];
    for (const scope of scopes) {
      if (unbound && unbound(scope, deal)) continue;
      const { nodes, deepest } = resolve(scope, rel);
      const targets: { at: Node; present: boolean }[] = nodes.length
        ? nodes.map((n) => ({ at: n, present: entry.attribute ? n.attrs.has(entry.name) : n.children.some((c) => c.name === entry.name && c.text !== null) }))
        : [{ at: deepest, present: false }];
      for (const { at, present } of targets) {
        if (present || !entryBinds(entry, at, scope)) continue;
        const required = entry.requirement === "required" || holds(condition!, at, scope, deal);
        if (!required) continue;
        const missingAt = nodes.length ? instancePath(at) : [instancePath(at), ...rel.slice(depthBelow(at, scope))].join("/");
        const gap: DuGap = { code: "DU_REQUIRED_MISSING", xpath: `${missingAt}/${entry.attribute ? "@" : ""}${entry.name}`, detail: entry.condition ? `conditional: ${entry.condition}` : `required (DU Map${entry.formFieldId ? ` form field ${entry.formFieldId}` : ""})` };
        if (mode === "refuse") throw new DuEmitError(gap.code, gap.xpath, gap.detail);
        if (!gaps.some((g) => g.xpath === gap.xpath)) gaps.push(gap);
      }
    }
  }
  return gaps;
}

/** How many of a relative path's steps `at` already covers below `scope` (for naming the missing path when a container is absent). */
function depthBelow(at: Node, scope: Node): number {
  let depth = 0;
  for (let cur: Node | null = at; cur && cur !== scope; cur = cur.parent) depth++;
  return depth;
}

/**
 * Rule 2 read back off a document: every element's children in `CHILD_ORDER[type]` sequence, typed the way the walk
 * types them (TYPE_FOR_PATH, then the EXTENSION / OTHER rules, then a container's own name). Empty when the document is
 * in schema order; otherwise one line per violation naming the element and the two children out of sequence (T3).
 */
export function orderViolations(xml: string | Uint8Array): string[] {
  const root = parseXml(typeof xml === "string" ? xml : new TextDecoder().decode(xml));
  const out: string[] = [];
  const visit = (el: XmlElement, path: string, type: string): void => {
    if (el.name === "RELATIONSHIPS") return;
    const order = CHILD_ORDER[type];
    if (!order) { out.push(`${path}: no child sequence for type ${type}`); return; }
    let last = -1; let lastName = "";
    for (const c of el.children) {
      const at = order.indexOf(c.name);
      if (at < 0) { out.push(`${path}/${c.name}: not in the ${type} sequence`); continue; }
      if (at < last) out.push(`${path}: ${c.name} follows ${lastName}; the ${type} sequence puts it before`);
      last = at; lastName = c.name;
      if (c.name === "RELATIONSHIPS") continue; // the arcs: RELATIONSHIP elements only, no sequence of their own (as `walk` treats it)
      const childPath = `${path}/${c.name}`;
      const childType = TYPE_FOR_PATH[childPath] ?? (c.name === "EXTENSION" && CHILD_ORDER[`${type}_EXTENSION`] ? `${type}_EXTENSION` : c.name === "OTHER" && type.endsWith("_EXTENSION") && CHILD_ORDER[`${type}/OTHER`] ? `${type}/OTHER` : CHILD_ORDER[c.name] ? c.name : null);
      if (childType === null) { if (c.children.length) out.push(`${childPath}: a container the generated tables do not know under ${type}`); continue; }
      if (c.children.length) visit(c, childPath, childType);
    }
  };
  visit(root, "MESSAGE", "MESSAGE");
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Serialization

const escapeText = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s: string): string => escapeText(s).replace(/"/g, "&quot;");

function serialize(n: Node, type: string, depth: number, out: string[]): void {
  const indent = "\t".repeat(depth);
  const attrs = [...n.attrs].map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join("");
  if (n.text !== null) { out.push(`${indent}<${n.name}${attrs}>${escapeText(n.text)}</${n.name}>`); return; }
  if (!n.children.length) { out.push(`${indent}<${n.name}${attrs}/>`); return; }
  out.push(`${indent}<${n.name}${attrs}>`);
  if (n.name === "RELATIONSHIPS") {
    for (const c of n.children) serialize(c, "", depth + 1, out);
  } else {
    const order = CHILD_ORDER[type]!;
    const path = canonicalPath(n);
    for (const name of order) for (const c of n.children) if (c.name === name) serialize(c, typeOfChild(path, type, c) ?? "", depth + 1, out);
  }
  out.push(`${indent}</${n.name}>`);
}

// ---------------------------------------------------------------------------------------------------------------------
// Assembly

const byPosition = (a: DuContainer | DuArc, b: DuContainer | DuArc): number => {
  const oa = (a as DuContainer).ordinal ?? null; const ob = (b as DuContainer).ordinal ?? null;
  if (oa !== ob) { if (oa === null) return 1; if (ob === null) return -1; return oa - ob; }
  return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

export function assembleDuDocument(graph: DuGraph, casefile: DuCasefileInput, submission: DuSubmissionInput, options: AssembleOptions = {}): DuDocument {
  const mode = options.conditionality ?? "refuse";
  if (!Number.isInteger(submission.submission_number) || submission.submission_number < 1) throw new DuEmitError("DU_SUBMISSION_NUMBER", "submission_number", `${submission.submission_number}`);
  if (!casefile.casefile_id) throw new DuEmitError("DU_REQUIRED_MISSING", "casefile_id", "the 23.1 casefile the document is assembled for");
  const AUS_PATH = "UNDERWRITING/AUTOMATED_UNDERWRITINGS/AUTOMATED_UNDERWRITING/AutomatedUnderwritingCaseIdentifier";
  const gaps: DuGap[] = [];
  if (graph.du_casefile_id !== null && submission.submission_number === 1) {
    throw new DuEmitError("DU_CASEFILE_ID_ON_FIRST_SUBMISSION", `${DEAL}/LOANS/LOAN/${AUS_PATH}`, `applications.du_casefile_id = ${graph.du_casefile_id} can only have come from a prior submission; this is submission 1`);
  }
  if (graph.du_casefile_id === null && submission.submission_number > 1) {
    // Rule 8: a resubmission carries DU's own identifier. Until the FAKE port's ack writes it (23.7), a runtime
    // resubmission has none; under `report` that is a gap the preflight holds, never an identifier of ours on the wire.
    const gap: DuGap = { code: "DU_REQUIRED_MISSING", xpath: `${DEAL}/LOANS/LOAN/${AUS_PATH}`, detail: `submission ${submission.submission_number} is a resubmission and applications.du_casefile_id is null` };
    if (mode === "refuse") throw new DuEmitError(gap.code, gap.xpath, gap.detail);
    gaps.push(gap);
  }

  const root = node("MESSAGE", null);
  for (const [k, v] of DU_ROOT_ATTRIBUTES) root.attrs.set(k, v);
  for (const [path, value] of Object.entries(graph.message)) place(root, path, value);

  // Containers: parents before children, each kind in its stable order; labels from the position (rule 1).
  const byId = new Map<string, DuContainer>();
  for (const c of graph.containers) {
    if (byId.has(c.id)) throw new DuEmitError("DU_DUPLICATE_CONTAINER", c.id, "two containers share an id");
    byId.set(c.id, c);
  }
  const nodes = new Map<string, Node>();
  const labels = new Map<string, string>();
  const counters = new Map<string, number>();
  const nextLabel = (prefix: string): string => { const n = (counters.get(prefix) ?? 0) + 1; counters.set(prefix, n); return `${prefix}_${n}`; };
  const partyLabel = new Map<string, string>();
  // Rule 1 / T8: every xlink:label unique. The XSD accepts a duplicate (23.6 Verified requirement), so the emitter is
  // the check: a ROLE's label is its PARTY's, and a PARTY with two ROLEs is refused, never numbered past the table.
  const assigned = new Set<string>();
  let borrowerCount = 0;
  for (const kind of KIND_ORDER) {
    const m = MOUNT[kind];
    const of = graph.containers.filter((c) => c.kind === kind).sort(byPosition);
    for (const c of of) {
      let owner: Node;
      if (m.parentKind === null) {
        if (c.parent !== null) throw new DuEmitError("DU_BAD_PARENT", c.id, `${kind} nests in nothing`);
        owner = root;
      } else {
        const parent = c.parent === null ? undefined : byId.get(c.parent);
        if (!parent || parent.kind !== m.parentKind) throw new DuEmitError("DU_BAD_PARENT", c.id, `${kind} nests in a ${m.parentKind}; parent ${c.parent ?? "null"} is ${parent?.kind ?? "absent"}`);
        owner = nodes.get(parent.id)!;
      }
      const el = mount(owner, m.path);
      nodes.set(c.id, el);
      if (m.sequenceNumber) el.attrs.set("SequenceNumber", String(el.parent!.children.filter((s) => s.name === el.name).length));
      for (const [path, value] of Object.entries(c.values)) place(el, path, value);
      if (kind === "PARTY") partyLabel.set(c.id, nextLabel("PARTY"));
      const label = kind === "ROLE" ? `${partyLabel.get(c.parent!)!}_ROLE` : m.label ? nextLabel(m.label) : null;
      if (label) {
        if (assigned.has(label)) throw new DuEmitError("DU_LABEL_DUPLICATE", instancePath(el), `${label} is already carried by another container`);
        assigned.add(label);
        el.attrs.set("xlink:label", label); labels.set(c.id, label);
      }
      if (kind === "ROLE" && collect(el, "PartyRoleType").includes("Borrower")) borrowerCount++;
    }
  }

  // Rule 8: DU's own identifier, on the subject loan, on a resubmission only.
  if (graph.du_casefile_id !== null) {
    const subject = graph.containers.filter((c) => c.kind === "LOAN" && c.values["@LoanRoleType"] === "SubjectLoan");
    if (subject.length !== 1) throw new DuEmitError("DU_REQUIRED_MISSING", `${DEAL}/LOANS/LOAN[@LoanRoleType="SubjectLoan"]`, `${subject.length} subject loans; the casefile identifier goes on one`);
    place(nodes.get(subject[0]!.id)!, AUS_PATH, graph.du_casefile_id);
  }

  // Arcs (rule 1): labels that exist in this document, arcroles from the table, disputed ones never.
  let disputed = 0;
  const arcs = [...graph.arcs].sort(byPosition);
  const relationships: Node[] = [];
  for (const arc of arcs) {
    const role = DU_ARCROLES[arc.arcrole];
    if (!role) throw new DuEmitError("DU_ARCROLE_UNKNOWN", DU_RELATIONSHIP_XPATH, `${arc.arcrole} is not in DU_ARCROLES`);
    if (role.from.disputed || role.to.disputed) { disputed++; continue; }
    const ends = [["from", arc.from, role.from.container], ["to", arc.to, role.to.container]] as const;
    const resolved: string[] = [];
    for (const [end, id, container] of ends) {
      const c = byId.get(id);
      if (!c) throw new DuEmitError("DU_ARC_DANGLING", DU_RELATIONSHIP_XPATH, `${arc.arcrole} ${end} ${id} names no container in the graph`);
      if (c.kind !== container) throw new DuEmitError("DU_ARC_ENDPOINT", DU_RELATIONSHIP_XPATH, `${arc.arcrole} ${end} must be a ${container}; ${id} is a ${c.kind}`);
      const label = labels.get(id);
      if (!label) throw new DuEmitError("DU_ARC_DANGLING", DU_RELATIONSHIP_XPATH, `${arc.arcrole} ${end} ${id} carries no xlink:label`);
      resolved.push(label);
    }
    const r = node("RELATIONSHIP", null);
    r.attrs.set("SequenceNumber", String(relationships.length + 1));
    r.attrs.set("xlink:from", resolved[0]!);
    r.attrs.set("xlink:to", resolved[1]!);
    r.attrs.set("xlink:arcrole", role.arcrole);
    relationships.push(r);
  }
  if (relationships.length) {
    const deal = resolve(root, DEAL.split("/").slice(1)).nodes[0] ?? childAt(childAt(childAt(childAt(root, "DEAL_SETS", 1), "DEAL_SET", 1), "DEALS", 1), "DEAL", 1);
    const rels = mount(deal, "RELATIONSHIPS");
    rels.attrs.set("xsi:type", "RELATIONSHIPS");
    for (const r of relationships) rels.children.push({ ...r, parent: rels });
  }

  // Rules 2–4, then the bytes.
  const leaves: Leaf[] = [];
  walk(root, "MESSAGE", "MESSAGE", leaves);
  for (const leaf of leaves) checkEnumeration(leaf);
  for (const leaf of leaves) checkFormat(leaf);
  gaps.push(...checkConditionality(root, mode));
  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];
  serialize(root, "MESSAGE", 0, lines);
  const bytes = new TextEncoder().encode(`${lines.join("\n")}\n`);
  return {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    stats: { container_count: graph.containers.length, relationship_count: relationships.length, borrower_count: borrowerCount, disputed_arcs_skipped: disputed },
    labels,
    gaps,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// loadGraph: the 23.5 rows as the document's graph

type Row = Record<string, unknown>;
const str = (r: Row, k: string): string | null => { const v = r[k]; return v === null || v === undefined ? null : String(v); };
const big = (r: Row, k: string): bigint | null => { const v = r[k]; return v === null || v === undefined ? null : typeof v === "bigint" ? v : BigInt(String(v)); };
const num = (r: Row, k: string): number | null => { const v = r[k]; return v === null || v === undefined ? null : Number(v); };
const bool = (r: Row, k: string): boolean | null => { const v = r[k]; return v === null || v === undefined ? null : Boolean(v); };
const yes = (r: Row, k: string): boolean | null => { const v = str(r, k); return v === null ? null : v === "Yes"; };
const id = (r: Row): string => String(r["id"]);
const stamp = (r: Row): string => str(r, "created_at") ?? "";

/** Drops the nulls: a data point the row does not carry is absent from the document, never an empty element (rule 4). */
function values(entries: Readonly<Record<string, DuValue | null | undefined>>): DuValues {
  const out: Record<string, DuValue> = {};
  for (const [k, v] of Object.entries(entries)) if (v !== null && v !== undefined) out[k] = v;
  return out;
}

function address(prefix: string, r: Row): Record<string, DuValue | null> {
  return {
    [`${prefix}/AddressLineText`]: str(r, "address_line_text"),
    [`${prefix}/AddressUnitIdentifier`]: str(r, "address_unit"),
    [`${prefix}/CityName`]: str(r, "city_name"),
    [`${prefix}/CountryCode`]: str(r, "country_code"),
    [`${prefix}/PostalCode`]: str(r, "postal_code"),
    [`${prefix}/StateCode`]: str(r, "state_code"),
  };
}

const CITIZENSHIP: Readonly<Record<string, string>> = { us_citizen: "USCitizen", permanent_resident: "PermanentResidentAlien", non_permanent_resident: "NonPermanentResidentAlien" };
const MARITAL: Readonly<Record<string, string>> = { married: "Married", unmarried: "Unmarried", separated: "Separated" };
/** 0057's `application_income.source_kind` → MISMO IncomeBase (MISMOEnumeratedTypesB324.xsd); a kind not listed is refused rather than guessed. */
const INCOME_TYPE: Readonly<Record<string, string>> = { base: "Base", overtime: "Overtime", bonus: "Bonus", commission: "Commissions", other: "Other" };

/** `legal_name` is one string on `application_borrowers`; DU wants FirstName / LastName. First token, last token, the rest in between — the only split a single column allows. */
function splitName(legal: string): { first: string; middle: string | null; last: string } {
  const parts = legal.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return { first: parts[0] ?? "", middle: null, last: "" };
  return { first: parts[0]!, middle: parts.length > 2 ? parts.slice(1, -1).join(" ") : null, last: parts[parts.length - 1]! };
}

/**
 * `ABOUT_VERSIONS/ABOUT_VERSION` as the runtime writes it: the specification identifier and nothing else.
 * `CreatedDatetime` is optional in the DU Map (DU_CONDITIONALITY: ABOUT_VERSION#CreatedDatetime optional) and is left
 * out on purpose — the request hash is the bytes (rule 6) and 23.1 rule 3 suppresses two identical hashes in a row
 * (23.1-T1's second identical build, made a day later, is refused as DUPLICATE_REQUEST_SUPPRESSED), so an instant in
 * the bytes would make every rebuild "new". The instant of emission is `du_documents.emitted_at`. The samples carry
 * one, and the loader keeps it, because the round trip reproduces the sample.
 */
export const RUNTIME_MESSAGE: DuValues = { "ABOUT_VERSIONS/ABOUT_VERSION/AboutVersionIdentifier": DU_ABOUT_VERSION_IDENTIFIER };

/**
 * The 23.5 graph (`readDuGraph`) as the document's graph: one PARTY + ROLE per borrowing party in ordinal order, an
 * ASSET / LIABILITY / EXPENSE per live row with its owner arcs, an EMPLOYER per employer row and a
 * CURRENT_INCOME_ITEM per income item that names one, the joint-credit self-loops, the declarations and residences
 * under the borrower's ROLE. What `readDuGraph` does not read is not here: the subject loan's terms, the collateral,
 * the originator parties, the income items with no employer.
 */
export async function loadGraph(q: Queryable, application_id: string): Promise<DuGraph> {
  const rows = await readDuGraph(q, application_id);
  // readDuGraph returns the income items that name an employer (23.5 rule 2: the arc). A wage item with none is still a
  // CURRENT_INCOME_ITEM — EmploymentIncomeIndicator false, no arc (23.6 Edge cases, T9) — so the rest are read here.
  const unemployed = await q.query<Row>(`SELECT * FROM application_income WHERE application_id = $1 AND employer_id IS NULL ORDER BY created_at, id`, [application_id]);
  const projected = projectGraph({ ...rows, income_items: [...rows.income_items, ...unemployed].sort((a, b) => (stamp(a) < stamp(b) ? -1 : stamp(a) > stamp(b) ? 1 : id(a) < id(b) ? -1 : 1)) });
  const graph = await withTaxpayerIdentifiers(q, application_id, projected);
  // 23.6 Inputs: `application_properties` — the subject property's address (COLLATERAL/SUBJECT_PROPERTY/ADDRESS, 4a.3)
  // and its unit count. The loan's own terms are not in any table: 23.1's snapshot carries them (ops-23-1.ts
  // dealFromSnapshot) and `withDeal` lays them over this graph.
  // 32.18 rule 7: the row also carries the two facts only the borrower gives — the estate (PropertyEstateType, L2.3) and
  // the clean-energy lien (PropertyExistingCleanEnergyLienIndicator, L1.10), asked on the home card and stored in its own
  // vocabulary (0137) — and the confirmed type, from which AttachmentType is derived (property-facts.ts: Detached /
  // Attached; a type that says neither, a PUD say, leaves the point absent — rule 4, never a default).
  const property = (await q.query<Row>(`SELECT address_line1, address_line2, city, state, postal_code, units, property_type, estate_type, existing_clean_energy_lien FROM application_properties WHERE application_id = $1 AND is_subject ORDER BY created_at, id LIMIT 1`, [application_id]))[0];
  if (!property) return graph;
  const S = `${DEAL.slice("MESSAGE/".length)}/COLLATERALS/COLLATERAL/SUBJECT_PROPERTY`;
  const postal = str(property, "postal_code")?.replace(/-/g, "") ?? null;
  const estate = str(property, "estate_type");
  const subject = values({
    [`${S}/ADDRESS/AddressLineText`]: str(property, "address_line1"),
    [`${S}/ADDRESS/AddressUnitIdentifier`]: str(property, "address_line2"),
    [`${S}/ADDRESS/CityName`]: str(property, "city"),
    [`${S}/ADDRESS/PostalCode`]: postal && /^(\d{5}|\d{9})$/.test(postal) ? postal : null,
    [`${S}/ADDRESS/StateCode`]: str(property, "state"),
    [`${S}/PROPERTY_DETAIL/AttachmentType`]: attachmentOf(str(property, "property_type")),
    [`${S}/PROPERTY_DETAIL/FinancedUnitCount`]: num(property, "units"),
    [`${S}/PROPERTY_DETAIL/PropertyEstateType`]: estate === null ? null : ESTATE_TYPE_OF_OPTION[estate] ?? null,
    [`${S}/PROPERTY_DETAIL/PropertyExistingCleanEnergyLienIndicator`]: bool(property, "existing_clean_energy_lien"),
  });
  return { ...graph, message: { ...subject, ...graph.message } };
}

/**
 * 32.18 rule 7: `TAXPAYER_IDENTIFIERS/TAXPAYER_IDENTIFIER` (1a.3, required) on each borrowing PARTY from the SSN the borrower
 * typed on 32.3 E5's one typed field — `application_borrowers.tin_encrypted` (0057, pii), decrypted here under the platform's
 * cipher (src/infra/pii/tin.ts) and put on the document only: the value is never logged, never on a payload, and the graph
 * that carries it lives for the assembly. A row with no cipher text leaves the data point absent (a gap the platform owns,
 * never a borrower ask); one that cannot be decrypted is a configuration fault named by borrower id, never by value.
 */
async function withTaxpayerIdentifiers(q: Queryable, application_id: string, graph: DuGraph): Promise<DuGraph> {
  const rows = await q.query<{ id: string; tin_encrypted: Buffer | Uint8Array | null }>(`SELECT id::text AS id, tin_encrypted FROM application_borrowers WHERE application_id = $1 AND tin_encrypted IS NOT NULL`, [application_id]);
  if (!rows.length) return graph;
  const key = tinCipherKey();
  const tins = new Map<string, string>();
  for (const r of rows) {
    if (!r.tin_encrypted) continue;
    let digits: string;
    try { digits = decryptTin(r.tin_encrypted, key); } catch { throw new Error(`application_borrowers.tin_encrypted cannot be read for borrower ${r.id} (TIN_CIPHER_KEY differs from the one it was written under)`); }
    if (/^\d{9}$/.test(digits)) tins.set(`party:${r.id}`, digits);
  }
  if (!tins.size) return graph;
  return { ...graph, containers: graph.containers.map((c) => (c.kind === "PARTY" && tins.has(c.id) ? { ...c, values: { ...c.values, "TAXPAYER_IDENTIFIERS/TAXPAYER_IDENTIFIER/TaxpayerIdentifierType": "SocialSecurityNumber", "TAXPAYER_IDENTIFIERS/TAXPAYER_IDENTIFIER/TaxpayerIdentifierValue": tins.get(c.id)! } } : c)) };
}

/** A graph with no rows: what a request built from 23.1's snapshot alone starts from (the deal facts come from `withDeal`). */
export function emptyGraph(application_id: string, du_casefile_id: string | null = null): DuGraph {
  return { application_id, du_casefile_id, message: { ...RUNTIME_MESSAGE }, containers: [], arcs: [] };
}

/** Deal-level facts no 23.5 row owns: the subject LOAN's data points (relative to the LOAN element) and MESSAGE-relative values (the collateral). */
export interface DuDeal { readonly loan: DuValues; readonly message: DuValues; }

/**
 * Lay a deal over a graph: the subject LOAN container is created when the graph has none (sorted first — `ordinal` 1),
 * else its values are merged; message values already present in the graph win (a row the database holds outranks a
 * snapshot's restatement of it). Nothing is removed and nothing is defaulted.
 */
export function withDeal(graph: DuGraph, deal: DuDeal): DuGraph {
  const subject = graph.containers.find((c) => c.kind === "LOAN" && c.values["@LoanRoleType"] === "SubjectLoan");
  const loan: DuContainer = subject
    ? { ...subject, values: { ...deal.loan, ...subject.values } }
    : { kind: "LOAN", id: "loan:subject", created_at: "", ordinal: 1, parent: null, values: { "@LoanRoleType": "SubjectLoan", ...deal.loan } };
  const containers = subject ? graph.containers.map((c) => (c === subject ? loan : c)) : [...graph.containers, loan];
  return { ...graph, message: { ...deal.message, ...graph.message }, containers };
}

export function projectGraph(rows: DuGraphRows): DuGraph {
  const containers: DuContainer[] = [];
  const arcs: DuArc[] = [];
  const roleOf = new Map<string, string>();
  for (const b of rows.borrowers) {
    const partyId = `party:${b.id}`;
    const roleId = `role:${b.id}`;
    roleOf.set(b.id, roleId);
    const name = splitName(b.legal_name);
    containers.push({
      kind: "PARTY", id: partyId, created_at: b.created_at, ordinal: b.borrower_ordinal, parent: null,
      values: values({
        "INDIVIDUAL/NAME/FirstName": name.first || null, "INDIVIDUAL/NAME/LastName": name.last || null, "INDIVIDUAL/NAME/MiddleName": name.middle,
      }),
    });
    const decl = rows.declarations.find((d) => d["application_borrower_id"] === b.id) ?? null;
    const d = decl ?? {};
    const citizenship = str(b, "citizenship_status");
    const marital = str(b, "marital_status");
    const dob = str(b, "date_of_birth");
    const chapters: Record<string, DuValue> = {};
    (decl?.bankruptcy_chapters ?? []).forEach((ch, i) => { chapters[`BORROWER/BANKRUPTCIES/BANKRUPTCY[${i + 1}]/BANKRUPTCY_DETAIL/BankruptcyChapterType`] = ch; });
    const residences: Record<string, DuValue | null> = {};
    rows.residences.filter((r) => r["application_borrower_id"] === b.id).forEach((r, i) => {
      const p = `BORROWER/RESIDENCES/RESIDENCE[${i + 1}]`;
      Object.assign(residences, address(`${p}/ADDRESS`, r), {
        [`${p}/LANDLORD/LANDLORD_DETAIL/MonthlyRentAmount`]: big(r, "monthly_rent_cents"),
        [`${p}/RESIDENCE_DETAIL/BorrowerResidencyBasisType`]: str(r, "residency_basis"),
        [`${p}/RESIDENCE_DETAIL/BorrowerResidencyDurationMonthsCount`]: num(r, "duration_months"),
        [`${p}/RESIDENCE_DETAIL/BorrowerResidencyType`]: str(r, "residency_type"),
      });
    });
    const D = "BORROWER/DECLARATION/DECLARATION_DETAIL";
    containers.push({
      kind: "ROLE", id: roleId, created_at: b.created_at, ordinal: b.borrower_ordinal, parent: partyId,
      values: values({
        "ROLE_DETAIL/PartyRoleType": "Borrower",
        "BORROWER/BORROWER_DETAIL/BorrowerBirthDate": dob,
        "BORROWER/BORROWER_DETAIL/MaritalStatusType": marital === null ? null : MARITAL[marital] ?? null,
        // application_borrowers.citizenship_status: the borrower's, written whether or not a du_declarations row exists yet.
        [`${D}/CitizenshipResidencyType`]: citizenship === null ? null : CITIZENSHIP[citizenship] ?? null,
        ...(decl ? {
          [`${D}/BankruptcyIndicator`]: yes(d, "bankruptcy"),
          [`${D}/FHASecondaryResidenceIndicator`]: yes(d, "fha_secondary_residence"),
          [`${D}/HomeownerPastThreeYearsType`]: str(d, "homeowner_past_three_years"),
          [`${D}/IntentToOccupyType`]: str(d, "intent_to_occupy"),
          [`${D}/OutstandingJudgmentsIndicator`]: yes(d, "outstanding_judgments"),
          [`${D}/PartyToLawsuitIndicator`]: yes(d, "party_to_lawsuit"),
          [`${D}/PresentlyDelinquentIndicator`]: yes(d, "presently_delinquent"),
          [`${D}/PriorPropertyDeedInLieuConveyedIndicator`]: yes(d, "prior_property_deed_in_lieu_conveyed"),
          [`${D}/PriorPropertyForeclosureCompletedIndicator`]: yes(d, "prior_property_foreclosure_completed"),
          [`${D}/PriorPropertyShortSaleCompletedIndicator`]: yes(d, "prior_property_short_sale_completed"),
          [`${D}/PriorPropertyTitleType`]: str(d, "prior_property_title"),
          [`${D}/PriorPropertyUsageType`]: str(d, "property_usage"),
          [`${D}/PropertyProposedCleanEnergyLienIndicator`]: yes(d, "property_proposed_clean_energy_lien"),
          [`${D}/UndisclosedBorrowedFundsAmount`]: big(d, "undisclosed_borrowed_funds_cents"),
          [`${D}/UndisclosedBorrowedFundsIndicator`]: yes(d, "undisclosed_borrowed_funds"),
          [`${D}/UndisclosedComakerOfNoteIndicator`]: yes(d, "undisclosed_comaker_of_note"),
          [`${D}/UndisclosedCreditApplicationIndicator`]: yes(d, "undisclosed_credit_application"),
          [`${D}/UndisclosedMortgageApplicationIndicator`]: yes(d, "undisclosed_mortgage_application"),
          [`${D}/EXTENSION/OTHER/ULAD:DECLARATION_DETAIL_EXTENSION/ULAD:SpecialBorrowerSellerRelationshipIndicator`]: yes(d, "special_borrower_seller_relationship"),
        } : {}),
        ...chapters,
        ...residences,
      }),
    });
  }
  const roleFor = (borrowerId: string, what: string): string => {
    const r = roleOf.get(borrowerId);
    if (!r) throw new DuEmitError("DU_ARC_DANGLING", DU_RELATIONSHIP_XPATH, `${what} names application_borrower ${borrowerId}, which is not a borrowing party of the application`);
    return r;
  };
  for (const a of rows.assets) {
    const kind = str(a, "kind");
    const p = a.owned_property;
    const isProperty = kind === "OWNED_PROPERTY";
    containers.push({
      kind: "ASSET", id: id(a), created_at: stamp(a), parent: null,
      values: values(isProperty && p ? {
        "OWNED_PROPERTY/OWNED_PROPERTY_DETAIL/OwnedPropertyDispositionStatusType": str(p, "disposition"),
        "OWNED_PROPERTY/OWNED_PROPERTY_DETAIL/OwnedPropertyLienUPBAmount": big(p, "lien_upb_cents"),
        "OWNED_PROPERTY/OWNED_PROPERTY_DETAIL/OwnedPropertyMaintenanceExpenseAmount": big(p, "monthly_expenses_cents"),
        "OWNED_PROPERTY/OWNED_PROPERTY_DETAIL/OwnedPropertyRentalIncomeGrossAmount": big(p, "monthly_rental_income_cents"),
        "OWNED_PROPERTY/OWNED_PROPERTY_DETAIL/OwnedPropertyRentalIncomeNetAmount": big(p, "monthly_net_rental_income_cents"),
        "OWNED_PROPERTY/OWNED_PROPERTY_DETAIL/OwnedPropertySubjectIndicator": bool(p, "is_subject"),
        ...address("OWNED_PROPERTY/PROPERTY/ADDRESS", p),
        "OWNED_PROPERTY/PROPERTY/PROPERTY_DETAIL/PropertyCurrentUsageType": str(p, "current_usage"),
        "OWNED_PROPERTY/PROPERTY/PROPERTY_DETAIL/PropertyEstimatedValueAmount": big(p, "market_value_cents"),
        "OWNED_PROPERTY/PROPERTY/PROPERTY_DETAIL/PropertyUsageType": str(p, "property_usage"),
        "OWNED_PROPERTY/PROPERTY/PROPERTY_DETAIL/PropertyUsageTypeOtherDescription": str(p, "property_usage_other_description"),
      } : {
        "ASSET_DETAIL/AssetCashOrMarketValueAmount": big(a, "cash_or_market_value_cents"),
        "ASSET_DETAIL/AssetType": str(a, "asset_type"),
        "ASSET_DETAIL/AssetTypeOtherDescription": str(a, "asset_type_other_description"),
        "ASSET_DETAIL/FundsSourceType": str(a, "funds_source_type"),
        "ASSET_DETAIL/FundsSourceTypeOtherDescription": str(a, "funds_source_type_other_description"),
        "ASSET_DETAIL/EXTENSION/OTHER/ULAD:ASSET_DETAIL_EXTENSION/ULAD:IncludedInAssetAccountIndicator": bool(a, "included_in_asset_account"),
        "ASSET_HOLDER/NAME/FullName": str(a, "institution_name"),
      }),
    });
    for (const o of a.owners) arcs.push({ id: `owner:${id(a)}:${o.application_borrower_id}`, created_at: o.created_at, arcrole: "ASSET_IsAssociatedWith_ROLE", from: id(a), to: roleFor(o.application_borrower_id, `du_asset_parties on ${id(a)}`) });
  }
  const assetOfProperty = new Map<string, string>();
  for (const a of rows.assets) if (a.owned_property) assetOfProperty.set(String(a.owned_property["id"]), id(a));
  for (const l of rows.liabilities) {
    containers.push({
      kind: "LIABILITY", id: id(l), created_at: stamp(l), parent: null,
      values: values({
        "LIABILITY_DETAIL/HELOCMaximumBalanceAmount": big(l, "heloc_maximum_balance_cents"),
        "LIABILITY_DETAIL/LiabilityExclusionIndicator": bool(l, "exclusion_indicator"),
        "LIABILITY_DETAIL/LiabilityMonthlyPaymentAmount": big(l, "monthly_payment_cents"),
        "LIABILITY_DETAIL/LiabilityPaymentIncludesTaxesInsuranceIndicator": bool(l, "payment_includes_taxes_insurance"),
        "LIABILITY_DETAIL/LiabilityPayoffStatusIndicator": bool(l, "paid_off_at_or_before_closing"),
        "LIABILITY_DETAIL/LiabilityRemainingTermMonthsCount": num(l, "remaining_term_months"),
        "LIABILITY_DETAIL/LiabilityType": str(l, "liability_type"),
        "LIABILITY_DETAIL/LiabilityTypeOtherDescription": str(l, "liability_type_other_description"),
        "LIABILITY_DETAIL/LiabilityUnpaidBalanceAmount": big(l, "unpaid_balance_cents"),
        "LIABILITY_DETAIL/MortgageType": str(l, "mortgage_type"),
        "LIABILITY_HOLDER/NAME/FullName": str(l, "creditor_name"),
      }),
    });
    for (const o of l.obligors) arcs.push({ id: `obligor:${id(l)}:${o.application_borrower_id}`, created_at: o.created_at, arcrole: "LIABILITY_IsAssociatedWith_ROLE", from: id(l), to: roleFor(o.application_borrower_id, `du_liability_parties on ${id(l)}`) });
    const secured = str(l, "secured_by_owned_property_id");
    if (secured !== null) {
      const asset = assetOfProperty.get(secured);
      if (!asset) throw new DuEmitError("DU_ARC_DANGLING", DU_RELATIONSHIP_XPATH, `du_liabilities.secured_by_owned_property_id ${secured} names no live owned property`);
      arcs.push({ id: `secures:${id(l)}`, created_at: stamp(l), arcrole: "ASSET_IsAssociatedWith_LIABILITY", from: asset, to: id(l) });
    }
  }
  for (const e of rows.expenses) {
    containers.push({
      kind: "EXPENSE", id: id(e), created_at: stamp(e), parent: null,
      values: values({
        "ExpenseMonthlyPaymentAmount": big(e, "monthly_payment_cents"),
        "ExpenseRemainingTermMonthsCount": num(e, "remaining_term_months"),
        "ExpenseType": str(e, "expense_type"),
        "ExpenseTypeOtherDescription": str(e, "expense_other_description"),
      }),
    });
    for (const o of e.payers) arcs.push({ id: `payer:${id(e)}:${o.application_borrower_id}`, created_at: o.created_at, arcrole: "EXPENSE_IsAssociatedWith_ROLE", from: id(e), to: roleFor(o.application_borrower_id, `du_expense_parties on ${id(e)}`) });
  }
  for (const em of rows.employers) {
    containers.push({
      kind: "EMPLOYER", id: id(em), created_at: stamp(em), parent: roleFor(String(em["application_borrower_id"]), `employers ${id(em)}`),
      values: values({
        "LEGAL_ENTITY/CONTACTS/CONTACT/CONTACT_POINTS/CONTACT_POINT/CONTACT_POINT_TELEPHONE/ContactPointTelephoneValue": str(em, "phone"),
        "LEGAL_ENTITY/LEGAL_ENTITY_DETAIL/FullName": str(em, "display_name"),
        ...address("ADDRESS", em),
      }),
    });
  }
  for (const inc of rows.income_items) {
    const kind = str(inc, "source_kind") ?? "";
    const incomeType = INCOME_TYPE[kind];
    if (!incomeType) throw new DuEmitError("DU_ENUM_NOT_SUPPORTED", `${DEAL}/PARTIES/PARTY/ROLES/ROLE/BORROWER/CURRENT_INCOME/CURRENT_INCOME_ITEMS/CURRENT_INCOME_ITEM/CURRENT_INCOME_ITEM_DETAIL/IncomeType`, `application_income.source_kind ${JSON.stringify(kind)} has no IncomeBase member in the loader's table`);
    const employer = str(inc, "employer_id");
    containers.push({
      kind: "CURRENT_INCOME_ITEM", id: id(inc), created_at: stamp(inc), parent: roleFor(String(inc["application_borrower_id"]), `application_income ${id(inc)}`),
      values: values({
        "CURRENT_INCOME_ITEM_DETAIL/CurrentIncomeMonthlyTotalAmount": big(inc, "monthly_amount_cents"),
        "CURRENT_INCOME_ITEM_DETAIL/EmploymentIncomeIndicator": employer !== null,
        "CURRENT_INCOME_ITEM_DETAIL/IncomeType": incomeType,
      }),
    });
    if (employer !== null) arcs.push({ id: `earns:${id(inc)}`, created_at: stamp(inc), arcrole: "CURRENT_INCOME_ITEM_IsAssociatedWith_EMPLOYER", from: id(inc), to: employer });
  }
  for (const link of rows.joint_credit_report_links) {
    arcs.push({ id: id(link), created_at: stamp(link), arcrole: "ROLE_SharesJointCreditReportWith_ROLE", from: roleFor(String(link["from_application_borrower_id"]), `du_joint_credit_report_links ${id(link)}`), to: roleFor(String(link["to_application_borrower_id"]), `du_joint_credit_report_links ${id(link)}`) });
  }
  return {
    application_id: rows.application_id,
    du_casefile_id: rows.du_casefile_id,
    message: { ...RUNTIME_MESSAGE },
    containers,
    arcs,
  };
}
