/**
 * 23.7 — preflight: what DU rejects that the schema accepts. The XSD proves a document is lexically legal and nothing
 * about the graph (23.6 Verified requirement: a dangling `xlink:to`, a duplicate label, an invented arcrole, five
 * borrowers, a deleted RELATIONSHIPS container all validate). `runDuPreflight` is the set of checks on the emitted
 * bytes and the graph behind them that encode what the corpus and the Cardinality / ArcRoles tabs say DU actually
 * requires, run between 23.6's emission and 23.1's `submit`, each refusal naming the XPath and the rule.
 *
 * The checks run in the spec's order (Business rules 1–8) with the credentials check first — T12: "before any other
 * check runs" — so a casefile with no seller number is refused before the document is even parsed, and a failed
 * credentials check is the only entry recorded. Every other check runs and is recorded whether or not an earlier one
 * failed; the refusal event names the first failure in that order. Nothing here edits the document to make a check
 * pass, and no `officer` waiver exists for a refusal, because every refusal is a document DU would reject.
 *
 * Events (subject = the application, so src/kernel/timers/engine.ts arms and satisfies `SM_DU_PREFLIGHT_GATE` —
 * armed by 23.6's `du.document.emitted`, satisfied by `du.preflight.passed`, both carrying `application_id`):
 *   du.preflight.passed{document_id, checks}                 [satisfies SM_DU_PREFLIGHT_GATE; 23.1's submit proceeds]
 *   du.preflight.refused{document_id, code, xpath, rule}     [the gate stays held; 23.1 does not transmit (T10)]
 * `document_id` in both is the `du_documents` row (the spec's `du_preflight_results.document_id → du_documents`);
 * `documents_row_id` beside it is the `documents` row 23.1's request carries as `document_id`, and `sha256` the hash,
 * so `preflightGate` can match a request to its result whichever id the caller holds.
 */
import { toJson, type Queryable } from "../../../infra/db/client.ts";
import type { Actor, DomainEvent, EventStore } from "../../../kernel/events/index.ts";
import { DU_ARCROLES, DU_RELATIONSHIP_XPATH } from "./generated/arcroles.ts";
import { DU_CARDINALITY } from "./generated/cardinality.ts";
import { DU_CONTAINER_PATHS, type DuContainerKind, type DuGraph, type DuSubmissionInput } from "./emit.ts";
import { attr, parseXml, type XmlElement } from "./xml.ts";

export const DU_PREFLIGHT_PASSED = "du.preflight.passed";
export const DU_PREFLIGHT_REFUSED = "du.preflight.refused";
export const DU_PREFLIGHT_RULE_SET = "23.7@preflight.v1";
const UNDERWRITER: Actor = { kind: "agent", id: "underwriter" };

/** The check codes, in the order the checks run: credentials first (T12), then Business rules 1–7 as written. */
export const DU_PREFLIGHT_CODES = [
  "DU_PREFLIGHT_CREDENTIALS",
  "DU_PREFLIGHT_DANGLING_ARC", "DU_PREFLIGHT_DUPLICATE_LABEL", "DU_PREFLIGHT_UNKNOWN_ARCROLE", "DU_PREFLIGHT_DISPUTED_ARC", "DU_PREFLIGHT_NO_GRAPH",
  "DU_PREFLIGHT_BORROWER_COUNT", "DU_PREFLIGHT_CARDINALITY", "DU_PREFLIGHT_SEQUENCE",
  "DU_PREFLIGHT_ORPHAN",
  "DU_PREFLIGHT_NOTHING_TO_UNDERWRITE",
  "DU_PREFLIGHT_DUPLICATE_ASSET",
  "DU_PREFLIGHT_EMPLOYER_ARC",
  "DU_PREFLIGHT_CASEFILE_ID",
] as const;
export type PreflightCode = (typeof DU_PREFLIGHT_CODES)[number];

/** The spec's rule behind each code (23.7 Business rules and calculations), quoted on the refusal event. */
export const DU_PREFLIGHT_RULES: Readonly<Record<PreflightCode, string>> = {
  DU_PREFLIGHT_CREDENTIALS: "23.7 rule 8 — credentials present: du_casefiles.seller_number, system_id_ref, tsp_product_ref non-empty (checked before any other check, T12)",
  DU_PREFLIGHT_DANGLING_ARC: "23.7 rule 1 — graph integrity: every xlink:from / xlink:to names a label in the document",
  DU_PREFLIGHT_DUPLICATE_LABEL: "23.7 rule 1 — graph integrity: labels are unique",
  DU_PREFLIGHT_UNKNOWN_ARCROLE: "23.7 rule 1 — graph integrity: every arcrole is one of the eleven in DU_ARCROLES",
  DU_PREFLIGHT_DISPUTED_ARC: "23.7 rule 1 — graph integrity: a disputed arcrole is never present (23.5 Open question 2: nobody downstream picks an endpoint)",
  DU_PREFLIGHT_NO_GRAPH: "23.7 rule 1 — graph integrity: a RELATIONSHIPS container exists when any owned container (ASSET, LIABILITY, EXPENSE) does",
  DU_PREFLIGHT_BORROWER_COUNT: "23.7 rule 2 — cardinality: borrowers ≤ 4 (DU allows four; none is DU_PREFLIGHT_NOTHING_TO_UNDERWRITE, T4)",
  DU_PREFLIGHT_CARDINALITY: "23.7 rule 2 — cardinality: per-container limits from DU_CARDINALITY (v1.9.3 Cardinality tab; 50 per ASSETS / LIABILITIES / EXPENSES)",
  DU_PREFLIGHT_SEQUENCE: "23.7 rule 2 — cardinality: SequenceNumber unique and contiguous from 1 within a container",
  DU_PREFLIGHT_ORPHAN: "23.7 rule 3 — ownership on the wire: every ASSET, LIABILITY, EXPENSE has ≥ 1 arc to a ROLE",
  DU_PREFLIGHT_NOTHING_TO_UNDERWRITE: "23.7 rule 4 — substance: a LOANS container with one subject LOAN, a PARTY per borrower with a ROLE, a subject property, a credit reference per borrower for a non-credit_only submission",
  DU_PREFLIGHT_DUPLICATE_ASSET: "23.7 rule 5 — duplicate assets: two ASSET containers with the same institution, subtype and last4 across two owners on one application (the joint-account double count; the fix is 22.4's reconciliation)",
  DU_PREFLIGHT_EMPLOYER_ARC: "23.7 rule 6 — employer arcs: a wage income item with EmploymentIncomeIndicator = true has an employer arc, and one without the indicator has none",
  DU_PREFLIGHT_CASEFILE_ID: "23.7 rule 7 — casefile identifier: absent on submission 1, present and equal to applications.du_casefile_id on submission > 1",
};

export interface PreflightCheck {
  readonly code: PreflightCode;
  readonly passed: boolean;
  /** The XPath the refusal names (instance form, `[n]` on a repeated sibling); a column name for the credentials check. */
  readonly xpath?: string;
  readonly detail?: string;
}
export interface PreflightRefusal { readonly code: PreflightCode; readonly xpath: string; readonly rule: string; readonly detail: string; }
export interface PreflightResult {
  readonly passed: boolean;
  /** One entry per check that ran, in order; a failed credentials check is the only entry (T12). */
  readonly checks: readonly PreflightCheck[];
  /** The first failed check in order, or null. */
  readonly refusal: PreflightRefusal | null;
  readonly rule_set_version: string;
}

/** What the credentials check reads: 23.1's `DuCasefile` satisfies it; the test loader's `{casefile_id}` alone does not. */
export interface PreflightCasefile {
  readonly casefile_id: string;
  readonly seller_number?: string | null | undefined;
  readonly system_id_ref?: string | null | undefined;
  readonly tsp_product_ref?: string | null | undefined;
  /** 23.1's associations; when present, a non-`credit_only` submission needs one per borrower (rule 4). */
  readonly credit_association?: readonly unknown[];
}

// ---------------------------------------------------------------------------------------------------------------------
// The document as the checks see it

interface Node { readonly el: XmlElement; readonly parent: Node | null; readonly canonical: string; readonly xpath: string; }
interface Labelled { readonly node: Node; readonly label: string; readonly kind: DuContainerKind | null; }
interface Arc { readonly node: Node; readonly from: string; readonly to: string; readonly uri: string; readonly name: string; }

const DEAL = "MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL";
const SUBJECT_LOAN_XPATH = `${DEAL}/LOANS/LOAN[@LoanRoleType="SubjectLoan"]`;
const AUS_PATH = "UNDERWRITING/AUTOMATED_UNDERWRITINGS/AUTOMATED_UNDERWRITING/AutomatedUnderwritingCaseIdentifier";
const OWNED: readonly DuContainerKind[] = ["ASSET", "LIABILITY", "EXPENSE"];

function nodes(root: XmlElement): Node[] {
  const out: Node[] = [];
  const visit = (el: XmlElement, parent: Node | null, canonical: string, xpath: string): void => {
    const n: Node = { el, parent, canonical, xpath };
    out.push(n);
    const counts = new Map<string, number>(); for (const c of el.children) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
    const seen = new Map<string, number>();
    for (const c of el.children) {
      const i = (seen.get(c.name) ?? 0) + 1; seen.set(c.name, i);
      visit(c, n, `${canonical}/${c.name}`, `${xpath}/${(counts.get(c.name) ?? 1) > 1 ? `${c.name}[${i}]` : c.name}`);
    }
  };
  visit(root, null, root.name, root.name);
  return out;
}
const child = (n: Node, ...names: string[]): XmlElement | undefined => { let el: XmlElement | undefined = n.el; for (const name of names) { el = el?.children.find((c) => c.name === name); if (!el) return undefined; } return el; };
const text = (n: Node, ...names: string[]): string | null => { const el = child(n, ...names); return el ? el.text.trim() : null; };
const isBorrowerRole = (n: Node): boolean => n.canonical === `${DEAL}/PARTIES/PARTY/ROLES/ROLE` && text(n, "ROLE_DETAIL", "PartyRoleType") === "Borrower";

// ---------------------------------------------------------------------------------------------------------------------
// The checks

/**
 * The twelve-plus-two checks of 23.7's Business rules over the emitted bytes and the graph behind them (the graph
 * supplies `applications.du_casefile_id` for rule 7), the casefile (rule 8, rule 4's credit references) and the
 * submission (its number and type). Pure: no I/O, no event; `recordDuPreflight` persists and emits.
 */
export function runDuPreflight(bytes: Uint8Array | string, graph: Pick<DuGraph, "du_casefile_id">, casefile: PreflightCasefile, submission: DuSubmissionInput): PreflightResult {
  const checks: PreflightCheck[] = [];
  const pass = (code: PreflightCode, detail?: string): void => { checks.push({ code, passed: true, ...(detail ? { detail } : {}) }); };
  const fail = (code: PreflightCode, xpath: string, detail: string): void => { checks.push({ code, passed: false, xpath, detail }); };
  const finish = (): PreflightResult => {
    const first = checks.find((c) => !c.passed);
    return { passed: !first, checks, refusal: first ? { code: first.code, xpath: first.xpath ?? "", rule: DU_PREFLIGHT_RULES[first.code], detail: first.detail ?? "" } : null, rule_set_version: DU_PREFLIGHT_RULE_SET };
  };

  // Rule 8 first (T12): whose credentials the submission goes in under — the partner's seller number with SM's TSP identity.
  const blank = (["seller_number", "system_id_ref", "tsp_product_ref"] as const).filter((k) => typeof casefile[k] !== "string" || !casefile[k]!.trim());
  if (blank.length) { fail("DU_PREFLIGHT_CREDENTIALS", `du_casefiles.${blank[0]}`, `${blank.map((k) => `du_casefiles.${k}`).join(", ")} empty on casefile ${casefile.casefile_id}; no other check ran`); return finish(); }
  pass("DU_PREFLIGHT_CREDENTIALS", `seller_number ${casefile.seller_number}, system_id_ref ${casefile.system_id_ref}, tsp_product_ref ${casefile.tsp_product_ref}`);

  const root = parseXml(typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes));
  const all = nodes(root);
  const labelled: Labelled[] = all.flatMap((node) => { const label = attr(node.el, "xlink:label"); return label === undefined ? [] : [{ node, label, kind: DU_CONTAINER_PATHS[node.canonical] ?? null }]; });
  const labels = new Set(labelled.map((l) => l.label));
  const byLabel = new Map<string, Labelled>(); for (const l of labelled) if (!byLabel.has(l.label)) byLabel.set(l.label, l);
  const relationships = all.find((n) => n.canonical === `${DEAL}/RELATIONSHIPS`) ?? null;
  const arcs: Arc[] = all.filter((n) => n.canonical === DU_RELATIONSHIP_XPATH).map((node) => { const uri = attr(node.el, "xlink:arcrole") ?? ""; return { node, from: attr(node.el, "xlink:from") ?? "", to: attr(node.el, "xlink:to") ?? "", uri, name: uri.slice(uri.lastIndexOf("/") + 1) }; });
  const byUri = new Map(Object.values(DU_ARCROLES).map((r) => [r.arcrole, r] as const));

  // Rule 1 — graph integrity.
  const dangling = arcs.flatMap((a) => (["from", "to"] as const).filter((end) => !labels.has(a[end])).map((end) => ({ a, end })));
  if (dangling.length) fail("DU_PREFLIGHT_DANGLING_ARC", dangling[0]!.a.node.xpath, dangling.map(({ a, end }) => `${a.name} xlink:${end}="${a[end]}" names no label in the document (xlink:from="${a.from}" xlink:to="${a.to}")`).join("; "));
  else pass("DU_PREFLIGHT_DANGLING_ARC", `${arcs.length} arcs, every end a label of the document`);
  const seenLabel = new Set<string>(); const dup = labelled.filter((l) => (seenLabel.has(l.label) ? true : (seenLabel.add(l.label), false)));
  if (dup.length) fail("DU_PREFLIGHT_DUPLICATE_LABEL", dup[0]!.node.xpath, dup.map((l) => `xlink:label="${l.label}" is carried by ${byLabel.get(l.label)!.node.xpath} and ${l.node.xpath}`).join("; "));
  else pass("DU_PREFLIGHT_DUPLICATE_LABEL", `${labelled.length} labels, all unique`);
  const unknown = arcs.filter((a) => !byUri.has(a.uri));
  if (unknown.length) fail("DU_PREFLIGHT_UNKNOWN_ARCROLE", unknown[0]!.node.xpath, unknown.map((a) => `xlink:arcrole="${a.uri}" is not one of the ${Object.keys(DU_ARCROLES).length} in DU_ARCROLES`).join("; "));
  else pass("DU_PREFLIGHT_UNKNOWN_ARCROLE", `every arcrole one of the ${Object.keys(DU_ARCROLES).length}`);
  const disputed = arcs.filter((a) => { const r = byUri.get(a.uri); return Boolean(r && (r.from.disputed || r.to.disputed)); });
  if (disputed.length) fail("DU_PREFLIGHT_DISPUTED_ARC", disputed[0]!.node.xpath, disputed.map((a) => `${a.name} is disputed (its endpoint names disagree between the ArcRoles tab's columns); the emitter never writes it`).join("; "));
  else pass("DU_PREFLIGHT_DISPUTED_ARC");
  const owned = labelled.filter((l) => l.kind !== null && OWNED.includes(l.kind));
  if (owned.length && !relationships) fail("DU_PREFLIGHT_NO_GRAPH", `${DEAL}/RELATIONSHIPS`, `${owned.length} owned container(s) (${owned.slice(0, 3).map((l) => l.label).join(", ")}${owned.length > 3 ? ", …" : ""}) and no RELATIONSHIPS container: the graph is missing`);
  else pass("DU_PREFLIGHT_NO_GRAPH", owned.length ? `RELATIONSHIPS present for ${owned.length} owned container(s)` : "no owned container; no graph required");

  // Rule 2 — cardinality.
  const borrowers = all.filter(isBorrowerRole);
  if (borrowers.length > 4) fail("DU_PREFLIGHT_BORROWER_COUNT", borrowers[4]!.xpath, `${borrowers.length} borrower ROLEs; DU allows four`);
  else pass("DU_PREFLIGHT_BORROWER_COUNT", `${borrowers.length} borrower ROLE(s)${borrowers.length === 0 ? " — none is DU_PREFLIGHT_NOTHING_TO_UNDERWRITE" : ""}`);
  const over: string[] = []; let overAt: string | null = null;
  for (const n of all) {
    const counts = new Map<string, number>(); for (const c of n.el.children) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
    for (const [name, count] of counts) {
      const row = DU_CARDINALITY[`${n.canonical}/${name}`];
      if (row?.du && count > row.du.max) { over.push(`${n.xpath}/${name}: ${count} > ${row.du.max}`); overAt ??= `${n.xpath}/${name}[${row.du.max + 1}]`; }
    }
  }
  if (over.length) fail("DU_PREFLIGHT_CARDINALITY", overAt!, over.join("; "));
  else pass("DU_PREFLIGHT_CARDINALITY", `no container over its DU_CARDINALITY maximum (${Object.keys(DU_CARDINALITY).length} XPaths)`);
  const seqBad: string[] = []; let seqAt: string | null = null;
  for (const n of all) {
    const groups = new Map<string, number[]>();
    for (const c of n.el.children) { const s = attr(c, "SequenceNumber"); if (s === undefined) continue; const g = groups.get(c.name) ?? []; g.push(Number(s)); groups.set(c.name, g); }
    for (const [name, seqs] of groups) {
      const sorted = [...seqs].sort((a, b) => a - b);
      const ok = sorted.every((v, i) => v === i + 1) && n.el.children.filter((c) => c.name === name).length === seqs.length;
      if (!ok) { seqBad.push(`${n.xpath}/${name}: SequenceNumbers ${seqs.join(",")} are not 1..${seqs.length}`); seqAt ??= `${n.xpath}/${name}`; }
    }
  }
  if (seqBad.length) fail("DU_PREFLIGHT_SEQUENCE", seqAt!, seqBad.join("; "));
  else pass("DU_PREFLIGHT_SEQUENCE");

  // Rule 3 — ownership on the wire: the database's deferred trigger already guarantees an owner; the document must show it.
  const ownersOf = (label: string): string[] => arcs.filter((a) => a.from === label && a.name.endsWith("_IsAssociatedWith_ROLE") && byLabel.get(a.to)?.kind === "ROLE").map((a) => a.to);
  const orphans = owned.filter((l) => ownersOf(l.label).length === 0);
  if (orphans.length) fail("DU_PREFLIGHT_ORPHAN", orphans[0]!.node.xpath, orphans.map((l) => `${l.label} (${l.kind}) has no ${l.kind}_IsAssociatedWith_ROLE arc`).join("; "));
  else pass("DU_PREFLIGHT_ORPHAN", `${owned.length} owned container(s), each arced to a ROLE`);

  // Rule 4 — substance.
  const loans = all.filter((n) => n.canonical === `${DEAL}/LOANS/LOAN`);
  const subjectLoans = loans.filter((n) => attr(n.el, "LoanRoleType") === "SubjectLoan");
  const partiesWithoutRole = all.filter((n) => n.canonical === `${DEAL}/PARTIES/PARTY` && !all.some((r) => r.parent?.parent === n && r.canonical === `${DEAL}/PARTIES/PARTY/ROLES/ROLE`));
  const subjectProperty = all.find((n) => n.canonical === `${DEAL}/COLLATERALS/COLLATERAL/SUBJECT_PROPERTY`);
  const creditShort = submission.submission_type !== "credit_only" && casefile.credit_association !== undefined && casefile.credit_association.length < borrowers.length;
  if (subjectLoans.length !== 1) fail("DU_PREFLIGHT_NOTHING_TO_UNDERWRITE", SUBJECT_LOAN_XPATH, `${subjectLoans.length} subject LOAN(s) in ${loans.length} LOAN container(s); one is required`);
  else if (borrowers.length === 0) fail("DU_PREFLIGHT_NOTHING_TO_UNDERWRITE", `${DEAL}/PARTIES/PARTY/ROLES/ROLE[ROLE_DETAIL/PartyRoleType="Borrower"]`, "no PARTY holds a borrower ROLE: nobody to underwrite");
  else if (partiesWithoutRole.length) fail("DU_PREFLIGHT_NOTHING_TO_UNDERWRITE", `${partiesWithoutRole[0]!.xpath}/ROLES/ROLE`, `${partiesWithoutRole.length} PARTY container(s) with no ROLE`);
  else if (!subjectProperty) fail("DU_PREFLIGHT_NOTHING_TO_UNDERWRITE", `${DEAL}/COLLATERALS/COLLATERAL/SUBJECT_PROPERTY`, "no subject property");
  else if (creditShort) fail("DU_PREFLIGHT_NOTHING_TO_UNDERWRITE", borrowers[casefile.credit_association!.length]!.xpath, `${casefile.credit_association!.length} credit association(s) on the casefile for ${borrowers.length} borrower ROLE(s) on a ${submission.submission_type ?? "credit_and_underwriting"} submission (23.1 REPORT_MISSING_FOR_BORROWER names the borrower; this names the ROLE)`);
  else pass("DU_PREFLIGHT_NOTHING_TO_UNDERWRITE", `one subject LOAN, ${borrowers.length} borrower ROLE(s), a subject property${casefile.credit_association !== undefined ? `, ${casefile.credit_association.length} credit association(s)` : ""}`);

  // Rule 5 — duplicate assets across owners (the joint-account double count).
  const assets = labelled.filter((l) => l.kind === "ASSET").map((l) => { const id = text(l.node, "ASSET_DETAIL", "AssetAccountIdentifier"); return { l, institution: text(l.node, "ASSET_HOLDER", "NAME", "FullName"), subtype: text(l.node, "ASSET_DETAIL", "AssetType"), last4: id ? id.slice(-4) : null, owners: [...new Set(ownersOf(l.label))].sort() }; });
  const dupAssets: string[] = []; let dupAt: string | null = null;
  for (let i = 0; i < assets.length; i++) for (let j = i + 1; j < assets.length; j++) {
    const a = assets[i]!, b = assets[j]!;
    if (!a.institution || !a.subtype || !a.last4 || a.institution !== b.institution || a.subtype !== b.subtype || a.last4 !== b.last4) continue;
    if (a.owners.join(",") === b.owners.join(",")) continue;   // the same owner set twice is a re-statement, not a double count across owners
    dupAssets.push(`${a.l.label} (owners ${a.owners.join("+") || "none"}) and ${b.l.label} (owners ${b.owners.join("+") || "none"}) both name ${a.institution} ${a.subtype} …${a.last4}`); dupAt ??= a.l.node.xpath;
  }
  if (dupAssets.length) fail("DU_PREFLIGHT_DUPLICATE_ASSET", dupAt!, dupAssets.join("; "));
  else pass("DU_PREFLIGHT_DUPLICATE_ASSET", `${assets.length} ASSET container(s), no institution/subtype/last4 repeated across owners`);

  // Rule 6 — employer arcs: the indicator DU reads and the arc DU reads cannot disagree.
  const items = labelled.filter((l) => l.kind === "CURRENT_INCOME_ITEM");
  const employerArcsOf = (label: string): Arc[] => arcs.filter((a) => a.from === label && a.name === "CURRENT_INCOME_ITEM_IsAssociatedWith_EMPLOYER");
  const badItems = items.flatMap((l) => { const employed = text(l.node, "CURRENT_INCOME_ITEM_DETAIL", "EmploymentIncomeIndicator") === "true"; const n = employerArcsOf(l.label).length; return employed === n > 0 ? [] : [{ l, employed, n }]; });
  if (badItems.length) fail("DU_PREFLIGHT_EMPLOYER_ARC", badItems[0]!.l.node.xpath, badItems.map(({ l, employed, n }) => (employed ? `${l.label}: EmploymentIncomeIndicator = true and no CURRENT_INCOME_ITEM_IsAssociatedWith_EMPLOYER arc` : `${l.label}: ${n} employer arc(s) on an item whose EmploymentIncomeIndicator is not true`)).join("; "));
  else pass("DU_PREFLIGHT_EMPLOYER_ARC", `${items.length} income item(s); indicator and employer arc agree on each`);

  // Rule 7 — DU's own casefile identifier: absent on submission 1, DU's on a resubmission.
  const ausNodes = subjectLoans.length === 1 ? all.filter((n) => n.parent && n.canonical === `${DEAL}/LOANS/LOAN/${AUS_PATH}` && isUnder(n, subjectLoans[0]!)) : [];
  const onWire = ausNodes.length ? ausNodes[0]!.el.text.trim() : null;
  const ausXpath = `${SUBJECT_LOAN_XPATH}/${AUS_PATH}`;
  if (submission.submission_number === 1 && onWire !== null) fail("DU_PREFLIGHT_CASEFILE_ID", ausNodes[0]!.xpath, `submission 1 carries AutomatedUnderwritingCaseIdentifier ${onWire}; DU mints the identifier on the first submission and ours is never DU's`);
  else if (submission.submission_number > 1 && onWire === null) fail("DU_PREFLIGHT_CASEFILE_ID", ausXpath, `submission ${submission.submission_number} is a resubmission and carries no AutomatedUnderwritingCaseIdentifier${graph.du_casefile_id === null ? " (applications.du_casefile_id is null: no first ack has been written)" : ` (applications.du_casefile_id = ${graph.du_casefile_id})`}`);
  else if (submission.submission_number > 1 && onWire !== graph.du_casefile_id) fail("DU_PREFLIGHT_CASEFILE_ID", ausNodes[0]!.xpath, `AutomatedUnderwritingCaseIdentifier ${onWire} on the wire; applications.du_casefile_id is ${graph.du_casefile_id ?? "null"}`);
  else pass("DU_PREFLIGHT_CASEFILE_ID", submission.submission_number === 1 ? "submission 1, no identifier on the wire" : `submission ${submission.submission_number} carries DU's ${onWire}`);

  return finish();
}
function isUnder(n: Node, ancestor: Node): boolean { for (let p = n.parent; p; p = p.parent) if (p === ancestor) return true; return false; }

// ---------------------------------------------------------------------------------------------------------------------
// Persisting and emitting

export interface RecordPreflightInput {
  readonly application_id: string;
  /** The du_documents row (23.6, 0129). */
  readonly du_document_id: string;
  /** The documents row holding the bytes — 23.1's request `document_id` — so a submit can find the result by it. */
  readonly document_id?: string | null;
  readonly sha256?: string | null;
  readonly casefile_id?: string | null;
  readonly submission_number?: number | null;
  readonly result: PreflightResult;
  readonly ran_at: string;
  readonly actor?: Actor;
  /** True when 23.1's submit ran the checks itself over a request no emission on the bus preceded (no du_documents row; `du_document_id` is then the documents row id the request carries). */
  readonly inline?: boolean;
}

/** The `du_preflight_results` row (every run, passing or not). Same transaction as the caller's. */
export async function persistDuPreflight(q: Queryable, i: RecordPreflightInput): Promise<{ id: string }> {
  const rows = await q.query<{ id: string }>(
    `INSERT INTO du_preflight_results (document_id, application_id, passed, checks, ran_at) VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING id::text AS id`,
    [i.du_document_id, i.application_id, i.result.passed, toJson(i.result.checks.map((c) => ({ code: c.code, passed: c.passed, xpath: c.xpath ?? null, detail: c.detail ?? null }))), i.ran_at]);
  return { id: rows[0]!.id };
}

/** `du.preflight.passed{document_id, checks}` or `du.preflight.refused{document_id, code, xpath, rule}` — subject the application (the gate's subject), `application_id` in the payload. */
export function emitDuPreflight(events: EventStore, i: RecordPreflightInput): DomainEvent {
  const actor = i.actor ?? UNDERWRITER;
  const base = { application_id: i.application_id, document_id: i.du_document_id, du_document_id: i.du_document_id, documents_row_id: i.document_id ?? null, sha256: i.sha256 ?? null, casefile_id: i.casefile_id ?? null, submission_number: i.submission_number ?? null, rule_set_version: i.result.rule_set_version, ran_at: i.ran_at, inline: i.inline ?? false, origination: true };
  if (i.result.passed) return events.append({ type: DU_PREFLIGHT_PASSED, applicationId: i.application_id, aggregate: { kind: "application", id: i.application_id }, actor, occurredAt: i.ran_at, payload: { ...base, passed: true, checks: i.result.checks, gate: "SM_DU_PREFLIGHT_GATE", gate_state: "open" } });
  const r = i.result.refusal!;
  return events.append({ type: DU_PREFLIGHT_REFUSED, applicationId: i.application_id, aggregate: { kind: "application", id: i.application_id }, actor, occurredAt: i.ran_at, payload: { ...base, passed: false, code: r.code, xpath: r.xpath, rule: r.rule, detail: r.detail, checks: i.result.checks, gate: "SM_DU_PREFLIGHT_GATE", gate_state: "held", transmitted: false } });
}

/** Persist (when a database is in hand) and emit, in that order, for one run. */
export async function recordDuPreflight(q: Queryable | null, events: EventStore, i: RecordPreflightInput): Promise<{ id: string | null; event: DomainEvent }> {
  const row = q ? await persistDuPreflight(q, i) : null;
  return { id: row?.id ?? null, event: emitDuPreflight(events, i) };
}

export interface PreflightResultRow {
  readonly id: string; readonly du_document_id: string; readonly document_id: string; readonly application_id: string; readonly casefile_id: string; readonly submission_number: number;
  readonly passed: boolean; readonly checks: readonly PreflightCheck[]; readonly ran_at: string;
}
/** Every preflight run of an application, oldest first (append-only: a re-run after a re-emission is a further row) — the ops record's `du.preflight` (src/runtime/app.ts applicationRecord; the deploy walk's twelfth outcome reads it). */
export async function listDuPreflight(q: Queryable, applicationId: string): Promise<PreflightResultRow[]> {
  const rows = await q.query<Record<string, unknown>>(
    `SELECT p.id::text AS id, p.document_id::text AS du_document_id, d.document_id::text AS document_id, p.application_id::text AS application_id, d.casefile_id, (doc.metadata->>'submission_number')::int AS submission_number, p.passed, p.checks, p.ran_at::text AS ran_at
       FROM du_preflight_results p JOIN du_documents d ON d.id = p.document_id JOIN documents doc ON doc.id = d.document_id WHERE p.application_id = $1 ORDER BY p.ran_at, p.created_at`, [applicationId]);
  return rows.map((r) => ({ id: String(r["id"]), du_document_id: String(r["du_document_id"]), document_id: String(r["document_id"]), application_id: String(r["application_id"]), casefile_id: String(r["casefile_id"]), submission_number: Number(r["submission_number"]), passed: Boolean(r["passed"]),
    checks: (typeof r["checks"] === "string" ? JSON.parse(r["checks"]) : r["checks"]) as PreflightCheck[], ran_at: String(r["ran_at"]) }));
}
/** The latest preflight result by du_documents id, documents id, or application. */
export async function readDuPreflight(q: Queryable, by: { du_document_id?: string | null; document_id?: string | null; application_id?: string | null }): Promise<PreflightResultRow | null> {
  const where = by.du_document_id ? ["p.document_id = $1", by.du_document_id] : by.document_id ? ["d.document_id = $1", by.document_id] : by.application_id ? ["p.application_id = $1", by.application_id] : null;
  if (!where) throw new RangeError("readDuPreflight needs du_document_id, document_id or application_id");
  const rows = await q.query<Record<string, unknown>>(
    `SELECT p.id::text AS id, p.document_id::text AS du_document_id, d.document_id::text AS document_id, p.application_id::text AS application_id, d.casefile_id, (doc.metadata->>'submission_number')::int AS submission_number, p.passed, p.checks, p.ran_at::text AS ran_at
       FROM du_preflight_results p JOIN du_documents d ON d.id = p.document_id JOIN documents doc ON doc.id = d.document_id WHERE ${where[0]} ORDER BY p.ran_at DESC, p.created_at DESC LIMIT 1`, [where[1]]);
  const r = rows[0];
  if (!r) return null;
  const checks = (typeof r["checks"] === "string" ? JSON.parse(r["checks"]) : r["checks"]) as PreflightCheck[];
  return { id: String(r["id"]), du_document_id: String(r["du_document_id"]), document_id: String(r["document_id"]), application_id: String(r["application_id"]), casefile_id: String(r["casefile_id"]), submission_number: Number(r["submission_number"]), passed: Boolean(r["passed"]), checks, ran_at: String(r["ran_at"]) };
}

// ---------------------------------------------------------------------------------------------------------------------
// The gate as 23.1's submit evaluates it

export interface PreflightGate {
  readonly open: boolean;
  /** `passed`: the latest result passed; `refused`: it did not; `not_run`: the document was emitted on this bus and never preflighted; `not_armed`: no emission of this document is on the bus, so no gate was armed — and nothing ran the checks either, so the gate is not open (23.1's submit runs them inline over the bytes it holds). */
  readonly state: "passed" | "refused" | "not_run" | "not_armed";
  readonly code: string | null; readonly xpath: string | null; readonly rule: string | null; readonly reason: string;
  readonly event: DomainEvent | null;
}
/**
 * `SM_DU_PREFLIGHT_GATE` for one document: armed by `du.document.emitted` on the bus, satisfied by the latest
 * `du.preflight.passed` for the same document, held by a later `du.preflight.refused` or by no result at all. The
 * document is matched by its hash when both sides carry one (the hash is the bytes, 23.6 rule 6 — a result over other
 * bytes under the same `documents` row id is not this document's), else by the `documents` row id 23.1's request
 * carries. With no emission of the document on the bus nothing armed the gate and nothing ran the checks: the gate is
 * not open — `not_armed` — and 23.1's submit runs the checks itself before any bytes reach the port (the spec's
 * trigger row: "on every submission"; no bypass exists).
 */
export function preflightGate(events: EventStore, doc: { readonly document_id?: string | null; readonly sha256?: string | null }): PreflightGate {
  const matches = (p: Record<string, unknown>, idKeys: readonly string[]): boolean => {
    const theirs = p["sha256"];
    if (doc.sha256 && typeof theirs === "string" && theirs) return theirs === doc.sha256;
    return doc.document_id ? idKeys.some((k) => p[k] === doc.document_id) : false;
  };
  const emitted = events.all().filter((e) => e.type === "du.document.emitted" && matches(e.payload as Record<string, unknown>, ["document_id"]));
  const results = events.all().filter((e) => (e.type === DU_PREFLIGHT_PASSED || e.type === DU_PREFLIGHT_REFUSED) && matches(e.payload as Record<string, unknown>, ["documents_row_id", "document_id", "du_document_id"]));
  const latest = results.at(-1) ?? null;
  if (latest?.type === DU_PREFLIGHT_PASSED) return { open: true, state: "passed", code: null, xpath: null, rule: null, reason: "du.preflight.passed: every check passed", event: latest };
  if (latest) { const p = latest.payload as Record<string, unknown>; return { open: false, state: "refused", code: String(p["code"]), xpath: String(p["xpath"] ?? ""), rule: String(p["rule"] ?? ""), reason: `du.preflight.refused ${String(p["code"])} at ${String(p["xpath"] ?? "")}: ${String(p["detail"] ?? "")}`, event: latest }; }
  if (emitted.length) return { open: false, state: "not_run", code: "SM_DU_PREFLIGHT_GATE", xpath: null, rule: "23.7 Timers and gates: not_before_gate armed on du.document.emitted, satisfied by du.preflight.passed", reason: "the document was emitted and preflight has not passed it", event: emitted.at(-1)! };
  return { open: false, state: "not_armed", code: "SM_DU_PREFLIGHT_GATE", xpath: null, rule: "23.7 Trigger & frequency: preflight runs on every submission, before any bytes reach the port", reason: "no du.document.emitted for this document on the bus: no gate armed and no preflight run", event: null };
}
