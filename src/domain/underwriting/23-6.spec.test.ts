// 23.6 Assemble and emit the DU Specification document (MISMO 3.4 B324 + DU/ULAD extensions)
// spec/sections/23-desktop-underwriter-and-the-credit-decision/23-6-assemble-and-emit-the-du-specification-document.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
//
// The emitter is pure (du/emit.ts), so most cases run on a graph in memory: the eighteen samples through the test-only
// loader (fixtures/du-sample-loader.ts) and 23.1's refinance fixture as a 23.5 graph (fixtures/du-refinance-fixture.ts).
// T4 and T7 also touch the tables 0135 creates — a refusal writes no `documents` row, a re-emission writes a second
// `du_documents` row with the same sha256 — on their own database `<base>_23_6` when Postgres answers (the database
// half is skipped, and said so, when it does not; the in-memory half always runs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  arcRolesInCorpus, assetTypeListsInMigration, diffAssetTypeChecks, diffDuEnumChecks, duEnumChecksInMigrations, duGraphMigrationPaths,
  migrationSources, parseGeneratedArcRoles, parseGeneratedAssetTypeSections, parseGeneratedEnums, parseGeneratedOrder, schemaOrderProblems,
} from "../../../tools/build-du.mjs";
import { connect, type Db, type Queryable } from "../../infra/db/client.ts";
import { testDatabase } from "../../infra/db/test-db.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { EscalationService } from "../../app/escalations.ts";
import { CommandBus, type CommandSpec } from "../../app/commands.ts";
import { AgentRegistry, loadAgentsFile } from "../../app/agents.ts";
import { EntityStore, toolCommand, type ToolInput, type ToolRuntime } from "../../app/tools.ts";
import { TOOLS_23_1 } from "../../app/tools/section23-1.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import { xmllintErrors } from "../../infra/integrations/du-schema/index.ts";
import { MemoryEventStore, FixedClock } from "../../kernel/events/index.ts";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { CHILD_ORDER } from "./du/generated/order.ts";
import { DU_ENUMERATIONS } from "./du/generated/enums.ts";
import { DU_CONDITIONALITY } from "./du/generated/conditionality.ts";
import { DU_ARCROLES } from "./du/generated/arcroles.ts";
import { assembleDuDocument, DuEmitError, loadGraph, orderViolations, projectGraph, withDeal, type DuContainer, type DuGraph } from "./du/emit.ts";
import { emitDuDocument, persistDuDocument } from "./du/persist.ts";
import { attr, diffDuDocument, loadSample, parseXml, sampleNames, type XmlElement } from "./fixtures/du-sample-loader.ts";
import { FIXTURE_DU_CASEFILE_ID, refinanceFixtureGraph } from "./fixtures/du-refinance-fixture.ts";
import { assertSubmittable, buildDuRequest, createCasefile, dealFromSnapshot, DuRefused, type DuCasefile, type DuSubmission, type UladSnapshot } from "./ops-23-1.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const ORDER_TS = resolve(ROOT, "src/domain/underwriting/du/generated/order.ts");

// ───────────────────────────────────────────────────────────── the refinance fixture (23.1-T1) and its graph
const B1 = { borrower_id: "B1", last_name: "Rivera", suffix: null, ssn_last4: "1234" };
const B2 = { borrower_id: "B2", last_name: "Rivera", suffix: null, ssn_last4: "5678" };
const REFI: UladSnapshot = { application_id: "APP-R", loan_purpose: "limited_cash_out_refinance", occupancy: "principal_residence", product: "fixed_30", amortization: "fixed", loan_term: 360, property_type: "sfr_detached", sales_price_cents: null, appraised_value_cents: 80_000_000n, loan_amount_cents: 56_000_000n,
  note_rate_pct: "6.125", qualifying_income_cents: 1_200_000n, total_obligations_cents: 456_000n, borrowers: [B1, B2], max_ltv_pct: "95.00" };
const PURCHASE: UladSnapshot = { application_id: "APP-P", loan_purpose: "purchase", occupancy: "principal_residence", product: "fixed_30", amortization: "fixed", loan_term: 360, property_type: "sfr_detached", sales_price_cents: 51_500_000n, appraised_value_cents: 51_500_000n, loan_amount_cents: 41_200_000n,
  note_rate_pct: "6.250", qualifying_income_cents: 625_000n, total_obligations_cents: 250_000n, borrowers: [{ borrower_id: "B3", last_name: "Okafor", suffix: null, ssn_last4: "9012" }], income_limited_product: true, max_ltv_pct: "97.00" };
const CASEFILE = { casefile_id: "casefile:refi", seller_number: "123456789", system_id_ref: "SYS-PARTNER-01" };
const FIRST = { submission_number: 1 };
const sha = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const lint = (bytes: Uint8Array | string): string[] => {
  const dir = mkdtempSync(join(tmpdir(), "du-23-6-"));
  try { const f = join(dir, "d.xml"); writeFileSync(f, bytes); return xmllintErrors(f); } finally { rmSync(dir, { recursive: true, force: true }); }
};
/** Every element of a parsed document with its canonical path, depth first. */
function elements(root: XmlElement): { el: XmlElement; path: string }[] {
  const out: { el: XmlElement; path: string }[] = [];
  const visit = (el: XmlElement, path: string): void => { out.push({ el, path }); for (const c of el.children) visit(c, `${path}/${c.name}`); };
  visit(root, root.name);
  return out;
}
const arcsOf = (root: XmlElement): { from: string; to: string; arcrole: string }[] => elements(root).filter((e) => e.el.name === "RELATIONSHIP").map((e) => ({ from: attr(e.el, "xlink:from")!, to: attr(e.el, "xlink:to")!, arcrole: (attr(e.el, "xlink:arcrole") ?? "").split("/").pop()! }));
/** The fixture with one container's values replaced. */
const withValues = (g: DuGraph, id: string, edit: (v: Record<string, DuContainer["values"][string]>) => void): DuGraph => ({ ...g, containers: g.containers.map((c) => { if (c.id !== id) return c; const v: Record<string, DuContainer["values"][string]> = { ...c.values }; edit(v); return { ...c, values: v }; }) });

// ───────────────────────────────────────────────────────────── the database half (T4, T7): own database, every migration
const { url: DB_URL, skip: skipDb } = await testDatabase(import.meta.url);
let db: Db | null = null;
let partnerPartyId = "";
test.before(async () => {
  if (skipDb) return;
  db = connect(DB_URL);
  partnerPartyId = (await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name) VALUES ('servicer', 'FAKE Partner 23.6') RETURNING id`))[0]!.id;
});
test.after(async () => { if (db) await db.end(); });
async function newApplication(): Promise<string> {
  return (await db!.query<{ id: string }>(`INSERT INTO applications (partner_party_id, channel, transaction_type, occupancy) VALUES ($1, 'organic', 'limited_cash_out', 'primary') RETURNING id`, [partnerPartyId]))[0]!.id;
}
const count = async (table: string, app: string): Promise<number> => Number((await db!.query<{ c: string }>(`SELECT count(*)::text AS c FROM ${table} WHERE application_id = $1`, [app]))[0]!.c);

test("23.6-T1: Given each of the eighteen samples in `corpus/samples/`, when it is loaded into a 23.5 graph and re-emitted, then the emitted document validates against the vendored chain and matches the sample container-for-container and arc-for-arc after label normalization.", () => {
  // Rule 7, all eighteen: loaded into a graph (containers by label, arcs from RELATIONSHIP), re-emitted STRICTLY (rule 4
  // refuses, so every sample is also a document with every required point present), validated against the vendored
  // chain, and diffed container for container, arc for arc after label normalization. A divergence names its XPath.
  const names = sampleNames();
  assert.equal(names.length, 18, names.join(", "));
  for (const name of names) {
    const sample = loadSample(name);
    const document = assembleDuDocument(sample.graph, sample.casefile, sample.submission);
    assert.deepEqual(document.gaps, [], `${name}: strict assembly leaves no gap`);
    assert.deepEqual(lint(document.bytes), [], `xmllint on the emitted ${name}`);
    const diff = diffDuDocument(document.bytes, sample.xml);
    assert.ok(diff.equal, `${name} differs at ${diff.xpath}: ${diff.detail}`);
    assert.equal(document.stats.relationship_count + document.stats.disputed_arcs_skipped, sample.graph.arcs.length, `${name}: every arc of the sample is emitted or counted as disputed`);
    assert.equal(document.stats.container_count, sample.graph.containers.length);
  }
});
test("23.6-T2: Given sample DI-C09, when re-emitted, then the `RELATIONSHIPS` block carries exactly its arcs: the two two-owner assets each yield two `ASSET_IsAssociatedWith_ROLE` arcs, the two two-obligor liabilities each two `LIABILITY_IsAssociatedWith_ROLE` arcs, two `ASSET_IsAssociatedWith_LIABILITY` (each of those owned properties securing one of those liabilities), and one `CURRENT_INCOME_ITEM_IsAssociatedWith_EMPLOYER` per employed income item.", () => {
  // The sample's shape, as literals (a grep of DI-C09's RELATIONSHIPS): ASSET_5 and ASSET_6 each to BORROWER_1 and BORROWER_2;
  // LIABILITY_1 and LIABILITY_2 each to both; ASSET_5 → LIABILITY_1 and ASSET_6 → LIABILITY_2; two employed income items.
  const sample = loadSample("DI-C09");
  const document = assembleDuDocument(sample.graph, sample.casefile, sample.submission);
  const root = parseXml(text(document.bytes));
  const arcs = arcsOf(root);
  const sampleArcs = arcsOf(parseXml(sample.xml));
  assert.equal(arcs.length, sampleArcs.length, "exactly the sample's arcs, no more");
  const by = (arcrole: string) => arcs.filter((a) => a.arcrole === arcrole);
  const ownersOf = new Map<string, number>(); for (const a of by("ASSET_IsAssociatedWith_ROLE")) ownersOf.set(a.from, (ownersOf.get(a.from) ?? 0) + 1);
  const twoOwner = [...ownersOf].filter(([, n]) => n === 2).map(([label]) => label);
  assert.equal(twoOwner.length, 2, "DI-C09 carries two assets with two owners");
  for (const label of twoOwner) assert.equal(by("ASSET_IsAssociatedWith_ROLE").filter((a) => a.from === label).length, 2, `${label}: two ASSET_IsAssociatedWith_ROLE arcs`);
  assert.ok([...ownersOf.values()].every((n) => n <= 2));
  const obligorsOf = new Map<string, number>(); for (const a of by("LIABILITY_IsAssociatedWith_ROLE")) obligorsOf.set(a.from, (obligorsOf.get(a.from) ?? 0) + 1);
  const twoObligor = [...obligorsOf].filter(([, n]) => n === 2).map(([label]) => label);
  assert.equal(twoObligor.length, 2, "DI-C09 carries two liabilities with two obligors");
  for (const label of twoObligor) assert.equal(by("LIABILITY_IsAssociatedWith_ROLE").filter((a) => a.from === label).length, 2, `${label}: two LIABILITY_IsAssociatedWith_ROLE arcs`);
  // The asset securing a liability: one ASSET_IsAssociatedWith_LIABILITY arc per secured liability, from an OWNED_PROPERTY asset.
  const securing = by("ASSET_IsAssociatedWith_LIABILITY");
  assert.equal(securing.length, 2);
  assert.deepEqual(securing.map((a) => a.from).sort(), [...twoOwner].sort(), "the two securing assets are the two two-owner assets");
  assert.deepEqual(securing.map((a) => a.to).sort(), [...twoObligor].sort(), "…and each secures one of the two two-obligor liabilities");
  for (const arc of securing) assert.equal(securing.filter((a) => a.to === arc.to).length, 1, `${arc.to} is secured by one asset`);
  const labelled = new Map(elements(root).filter((e) => attr(e.el, "xlink:label")).map((e) => [attr(e.el, "xlink:label")!, e.el]));
  for (const arc of securing) assert.ok(labelled.get(arc.from)!.children.some((c) => c.name === "OWNED_PROPERTY"), `${arc.from} is an owned property`);
  // One CURRENT_INCOME_ITEM_IsAssociatedWith_EMPLOYER per employed income item — and none for the items that are not.
  const items = elements(root).filter((e) => e.el.name === "CURRENT_INCOME_ITEM").map((e) => e.el);
  const employed = items.filter((it) => elements(it).some((x) => x.el.name === "EmploymentIncomeIndicator" && x.el.text.trim() === "true"));
  assert.equal(employed.length, 2); assert.equal(items.length - employed.length, 3);
  const employerArcs = by("CURRENT_INCOME_ITEM_IsAssociatedWith_EMPLOYER");
  assert.equal(employerArcs.length, 2); assert.equal(employerArcs.length, employed.length);
  for (const it of employed) assert.equal(employerArcs.filter((a) => a.from === attr(it, "xlink:label")).length, 1, `${attr(it, "xlink:label")} → one employer`);
  for (const it of items.filter((x) => !employed.includes(x))) assert.equal(employerArcs.filter((a) => a.from === attr(it, "xlink:label")).length, 0);
  // Every arcrole URI written is the generated table's, and the two disputed arcs are not among them.
  for (const a of arcs) assert.equal(DU_ARCROLES[a.arcrole]?.arcrole, `urn:fdc:mismo.org:2009:residential/${a.arcrole}`);
  assert.equal(document.stats.disputed_arcs_skipped, 0);
});
test("23.6-T3: Given the refinance fixture (23.1-T1), when the document is emitted, then every container's children appear in `CHILD_ORDER` sequence, and moving any one child breaks schema validation.", () => {
  const graph = refinanceFixtureGraph(REFI);
  const document = assembleDuDocument(graph, CASEFILE, FIRST);
  assert.deepEqual(document.gaps, []);
  const xml = text(document.bytes);
  assert.deepEqual(lint(xml), [], "the refinance fixture validates");
  // Every container's children in CHILD_ORDER sequence: the emitter's own reader agrees, and a direct check on the parsed tree does too.
  assert.deepEqual(orderViolations(xml), []);
  const root = parseXml(xml);
  let containers = 0;
  for (const { el, path } of elements(root)) {
    if (!el.children.length || el.name === "RELATIONSHIPS") continue;
    const type = path === "MESSAGE" ? "MESSAGE" : el.name;
    const order = CHILD_ORDER[type];
    if (!order) continue; // an EXTENSION / OTHER wrapper — typed by orderViolations above
    containers++;
    const idx = el.children.map((c) => order.indexOf(c.name));
    assert.ok(idx.every((n) => n >= 0), `${path}: every child is in the ${type} sequence`);
    for (let i = 1; i < idx.length; i++) assert.ok(idx[i]! >= idx[i - 1]!, `${path}: ${el.children[i]!.name} follows ${el.children[i - 1]!.name}`);
  }
  assert.ok(containers >= 40, `${containers} containers checked`);
  // Moving any one child breaks schema validation: in each of these containers, the first two leaf children swapped is a document xmllint refuses.
  const lines = xml.split("\n");
  const swapped: string[] = [];
  const MOVED = ["TERMS_OF_LOAN", "AMORTIZATION_RULE", "LOAN_DETAIL", "PROPERTY_DETAIL", "DECLARATION_DETAIL", "RESIDENCE_DETAIL", "ASSET_DETAIL", "OWNED_PROPERTY_DETAIL", "LIABILITY_DETAIL", "CURRENT_INCOME_ITEM_DETAIL", "BORROWER_DETAIL", "EMPLOYMENT", "TAXPAYER_IDENTIFIER", "ADDRESS"];
  for (const container of MOVED) {
    const open = lines.findIndex((l) => l.trim() === `<${container}>`);
    assert.ok(open >= 0, `${container} is in the document`);
    const leaf = (l: string): boolean => /^\s*<([A-Za-z:]+)>[^<]*<\/\1>$/.test(l);
    assert.ok(leaf(lines[open + 1]!) && leaf(lines[open + 2]!), `${container}'s first two children are leaves`);
    const edited = [...lines]; [edited[open + 1], edited[open + 2]] = [lines[open + 2]!, lines[open + 1]!];
    const moved = edited.join("\n");
    assert.notEqual(moved, xml);
    assert.ok(lint(moved).length > 0, `${container}: xmllint refuses the moved child`);
    assert.ok(orderViolations(moved).length > 0, `${container}: orderViolations names the moved child`);
    swapped.push(container);
  }
  assert.equal(swapped.length, MOVED.length);
});
test("23.6-T4: Given a data point whose value is in the MISMO enumeration but not in `DU_ENUMERATIONS`, when emitted, then the emission is refused with `DU_ENUM_NOT_SUPPORTED` naming the XPath, and no `documents` row is written.", async () => {
  // `Annuity` is a member of MISMO's AssetBase (MISMOEnumeratedTypesB324.xsd) and not of the DU Enumerations tab's AssetType.
  assert.ok(!(DU_ENUMERATIONS.DuAssetType ?? []).includes("Annuity"));
  assert.ok(readFileSync(resolve(ROOT, "src/infra/integrations/du-schema/xsd/MISMOEnumeratedTypesB324.xsd"), "utf8").includes('<xsd:enumeration value="Annuity"'));
  const graph = withValues(refinanceFixtureGraph(REFI), "asset:checking", (v) => { v["ASSET_DETAIL/AssetType"] = "Annuity"; });
  const refusal = (e: unknown): boolean => e instanceof DuEmitError && e.code === "DU_ENUM_NOT_SUPPORTED" && /\/ASSETS\/ASSET(\[1\])?\/ASSET_DETAIL\/AssetType$/.test(e.xpath) && /DuAssetType/.test(e.detail) && /CheckingAccount/.test(e.detail);
  assert.throws(() => assembleDuDocument(graph, CASEFILE, FIRST), refusal, "refused before validation, naming the XPath and the DU-admitted list");
  assert.throws(() => assembleDuDocument(graph, CASEFILE, FIRST, { conditionality: "report" }), refusal, "an enumeration is refused under report too — a gap is a missing fact, not a wrong one");
  // No `documents` row is written: the persisting path refuses before the first INSERT, appends du.document.refused, and the tables stay empty.
  const events = new MemoryEventStore(new FixedClock("2026-10-06T15:00:00.000Z"));
  await assert.rejects(emitDuDocument(null, events, { graph, casefile: CASEFILE, submission: FIRST, emitted_at: "2026-10-06T15:00:00.000Z" }), refusal);
  const refused = events.ofType("du.document.refused");
  assert.equal(refused.length, 1); assert.equal(refused[0]!.payload["code"], "DU_ENUM_NOT_SUPPORTED"); assert.match(String(refused[0]!.payload["path"]), /ASSET_DETAIL\/AssetType$/); assert.equal(refused[0]!.payload["documents_row_written"], false);
  assert.equal(events.ofType("du.document.emitted").length, 0);
  if (skipDb) { console.log(`  (documents-row assertion on the database skipped: ${skipDb})`); return; }
  const app = await newApplication();
  await assert.rejects(db!.tx((q) => emitDuDocument(q, events, { graph: { ...graph, application_id: app }, casefile: CASEFILE, submission: FIRST, emitted_at: "2026-10-06T15:00:00.000Z" })), refusal);
  assert.equal(await count("documents", app), 0); assert.equal(await count("du_documents", app), 0);
  // …and the same graph with the DU value writes exactly one of each.
  await db!.tx((q) => emitDuDocument(q, events, { graph: { ...refinanceFixtureGraph(REFI), application_id: app }, casefile: CASEFILE, submission: FIRST, emitted_at: "2026-10-06T15:00:00.000Z" }));
  assert.equal(await count("documents", app), 1); assert.equal(await count("du_documents", app), 1);
});
test("23.6-T5: Given a required data point with no value, when emitted, then the emission is refused with `DU_REQUIRED_MISSING` naming the XPath; given a conditional data point whose condition statement is false for this loan, then its absence is accepted; given the same missing point on 23.1's `buildDuRequest` (the runtime's `conditionality = report`, Discrepancy 3), then the document is written without the point — never an empty element — and the gap names the XPath in `required_missing` on the request, the `du_documents` row and `du.document.emitted`.", async () => {
  // A required point (DU Map 1a.1.1 FirstName) with no value: refused, the XPath named, no bytes.
  const noFirstName = withValues(refinanceFixtureGraph(REFI), "party:B1", (v) => { delete v["INDIVIDUAL/NAME/FirstName"]; });
  assert.throws(() => assembleDuDocument(noFirstName, CASEFILE, FIRST), (e: unknown) => e instanceof DuEmitError && e.code === "DU_REQUIRED_MISSING" && /\/PARTIES\/PARTY\[1\]\/INDIVIDUAL\/NAME\/FirstName$/.test(e.xpath) && /required/.test(e.detail));
  // The same, and the required subject-loan points (TERMS_OF_LOAN/LoanPurposeType is "required", DU Map 4a.2) named when the deal lacks them.
  const noPurpose: DuGraph = { ...refinanceFixtureGraph(REFI), containers: refinanceFixtureGraph(REFI).containers.map((c) => (c.kind === "LOAN" ? { ...c, values: Object.fromEntries(Object.entries(c.values).filter(([k]) => k !== "TERMS_OF_LOAN/LoanPurposeType")) } : c)) };
  assert.throws(() => assembleDuDocument(noPurpose, CASEFILE, FIRST), (e: unknown) => e instanceof DuEmitError && e.code === "DU_REQUIRED_MISSING" && /LOANS\/LOAN\/TERMS_OF_LOAN\/LoanPurposeType$/.test(e.xpath));
  // Under `report` the same document is written without the point and the gap is listed (23.7's gate reads it).
  const reported = assembleDuDocument(noFirstName, CASEFILE, FIRST, { conditionality: "report" });
  assert.equal(reported.gaps.length, 1); assert.match(reported.gaps[0]!.xpath, /PARTY\[1\]\/INDIVIDUAL\/NAME\/FirstName$/); assert.ok(!text(reported.bytes).includes("<FirstName></FirstName>"), "never an empty element");
  // A conditional point whose statement is false for this loan is accepted absent: LANDLORD_DETAIL/MonthlyRentAmount is
  // conditional on the residence being rented and the Riveras own; PriorPropertyUsageType on IntentToOccupyType = Yes AND
  // HomeownerPastThreeYearsType = Yes, and the Okafor purchase says No to the second. Both fixtures emit with neither and nothing refuses.
  const rent = DU_CONDITIONALITY.find((e) => e.name === "MonthlyRentAmount" && e.xpath.endsWith("RESIDENCE/LANDLORD/LANDLORD_DETAIL"));
  assert.ok(rent && rent.requirement === "conditional" && /Rent/.test(rent.condition ?? ""), JSON.stringify(rent));
  const usage = DU_CONDITIONALITY.find((e) => e.name === "PriorPropertyUsageType" && e.xpath.endsWith("DECLARATION_DETAIL"));
  assert.ok(usage && usage.requirement === "conditional" && /HomeownerPastThreeYearsType = "Yes"/.test(usage.condition ?? ""), JSON.stringify(usage));
  const refi = assembleDuDocument(refinanceFixtureGraph(REFI), CASEFILE, FIRST);
  assert.deepEqual(refi.gaps, []); assert.ok(!text(refi.bytes).includes("MonthlyRentAmount")); assert.ok(text(refi.bytes).includes("<BorrowerResidencyBasisType>Own</BorrowerResidencyBasisType>"));
  const purchase = assembleDuDocument(refinanceFixtureGraph(PURCHASE), CASEFILE, FIRST);
  assert.deepEqual(purchase.gaps, []); assert.ok(!text(purchase.bytes).includes("PriorPropertyUsageType")); assert.ok(text(purchase.bytes).includes("<HomeownerPastThreeYearsType>No</HomeownerPastThreeYearsType>"));
  assert.ok(text(refi.bytes).includes("<PriorPropertyUsageType>PrimaryResidence</PriorPropertyUsageType>"), "…and the Riveras, who say Yes twice, carry it");
  const noUsage = withValues(refinanceFixtureGraph(REFI), "role:B1", (v) => { delete v["BORROWER/DECLARATION/DECLARATION_DETAIL/PriorPropertyUsageType"]; });
  assert.throws(() => assembleDuDocument(noUsage, CASEFILE, FIRST), (e: unknown) => e instanceof DuEmitError && e.code === "DU_REQUIRED_MISSING" && /DECLARATION_DETAIL\/PriorPropertyUsageType$/.test(e.xpath) && /conditional/.test(e.detail));
  // (MonthlyRentAmount's statement ends in "AND exists" — a self-existence term the emitter reads as false for an absent point — so
  // its absence is accepted for a renter too; the statement that binds on its own terms, PriorPropertyUsageType, is the refusal above.)
  // The Trigger path (Discrepancy 3): 23.1's `buildDuRequest` on the bus assembles under `report`. In memory, with no database
  // behind the runtime, the graph is the deal alone: the collateral's required points the snapshot does not carry (StateCode,
  // PropertyEstateType — "the subject's estate type" of the discrepancy — …) are gaps, the request is built, the document
  // carries no empty element, the gaps name their XPaths on the request and the `du.document.emitted` payload
  // (`required_missing`), and no `du.document.refused` is appended.
  const clock = new FixedClock("2026-10-06T15:00:00.000Z");
  const casefileFor = (events: MemoryEventStore, application_id: string): DuCasefile => ({ ...createCasefile(events, { application_id, seller_number: "123456789", system_id_ref: "SYS-PARTNER-01", tsp_product_ref: "SM-TSP", score_model: "classic_fico", created_at: "2026-10-06T15:00:00.000Z" }).casefile, credit_association: association() });
  const bind = (rt: ToolRuntime): { agents: AgentRegistry; cmds: Map<string, CommandSpec<ToolInput, unknown>> } => {
    const agents = new AgentRegistry(); const escalates = new Map(loadAgentsFile().processes.map((p) => [p.process, p.escalates_to] as const));
    const cmds = new Map<string, CommandSpec<ToolInput, unknown>>();
    for (const d of TOOLS_23_1) { const cmd = toolCommand(d, rt, escalates.get(d.process) ?? []); agents.registerTool(d.agent, cmd.name); cmds.set(d.name, cmd); }
    return { agents, cmds };
  };
  type Built = { request: { xml_document: string; document: { required_missing: number; gaps: { code: string; xpath: string }[] } }; required_missing: number; sha256: string; persisted: boolean };
  const build = async (events: MemoryEventStore, rt: ToolRuntime, cf: DuCasefile, extra: Record<string, unknown> = {}): Promise<Built> => {
    const { agents, cmds } = bind(rt);
    const ctx: UowContext = { loanId: "", applicationId: cf.application_id, events, ledger: new MemoryLedger(), timers: new TimerEngine(loadOverriddenRegistry(), events, { processes: ["23.1"] }), clock, decide: () => {} };
    return (await new CommandBus(agents).execute(cmds.get("buildDuRequest")!, { kind: "agent", id: "underwriter" }, { casefile: cf, submission_type: "credit_and_underwriting", reason: "initial", snapshot: REFI, ...extra }, ctx)).output as Built;
  };
  const checkReported = (events: MemoryEventStore, out: Built): void => {
    assert.ok(out.required_missing > 0);
    assert.equal(out.required_missing, out.request.document.gaps.length); assert.equal(out.request.document.required_missing, out.required_missing);
    assert.ok(out.request.document.gaps.every((g) => g.code === "DU_REQUIRED_MISSING" && g.xpath.startsWith("MESSAGE/DEAL_SETS/")), "every gap names its XPath");
    assert.ok(!/<[A-Za-z:]+><\/[A-Za-z:]+>/.test(out.request.xml_document) && !/<[A-Za-z:]+\/>/.test(out.request.xml_document), "never an empty element");
    for (const g of out.request.document.gaps) assert.ok(!out.request.xml_document.includes(`<${g.xpath.split("/").pop()!}>`), `${g.xpath} is omitted, not written empty`);
    assert.equal(out.sha256, sha(out.request.xml_document));
    const emitted = events.ofType("du.document.emitted"); assert.equal(emitted.length, 1); assert.equal(emitted[0]!.payload["required_missing"], out.required_missing);
    assert.deepEqual((emitted[0]!.payload["gaps"] as { code: string; path: string }[]).map((g) => g.path), out.request.document.gaps.map((g) => g.xpath), "the gaps ride on the event, by XPath");
    assert.equal(events.ofType("du.document.refused").length, 0);
  };
  const events = new MemoryEventStore(clock); const cf = casefileFor(events, "APP-R");
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(events, clock), services: {}, ports: {} };
  const out = await build(events, rt, cf);
  checkReported(events, out);
  assert.equal(out.persisted, false, "no database, no documents row");
  assert.deepEqual(out.request.document.gaps.map((g) => g.xpath.split("SUBJECT_PROPERTY/")[1]), ["ADDRESS/StateCode", "PROPERTY_DETAIL/PropertyExistingCleanEnergyLienIndicator", "PROPERTY_DETAIL/AttachmentType", "PROPERTY_DETAIL/PropertyEstateType"], "the deal alone: four collateral points the snapshot does not carry");
  // …and `conditionality: "refuse"` on the same tool is the refusal rule 4 states (the 23.6 assembleDuDocument tool's own default), with `du.document.refused`.
  await assert.rejects(build(events, rt, cf, { conditionality: "refuse" }), (e: unknown) => /DU_REQUIRED_MISSING/.test(String((e as Error).message)));
  assert.equal(events.ofType("du.document.refused").length, 1); assert.equal(events.ofType("du.document.refused")[0]!.payload["code"], "DU_REQUIRED_MISSING"); assert.match(String(events.ofType("du.document.refused")[0]!.payload["path"]), /SUBJECT_PROPERTY\/ADDRESS\/StateCode$/);
  // The same missing point as above — FirstName — through the runtime's own path on Postgres: an application_borrowers row whose
  // legal_name yields no first name is loaded by the tool (loadGraph), the gap names PARTY[1]/INDIVIDUAL/NAME/FirstName, and the
  // deferred write lands the documents + du_documents rows with `required_missing` and the gaps' XPaths.
  if (skipDb) { console.log(`  (buildDuRequest on the database skipped: ${skipDb})`); return; }
  const app = await newApplication();
  await db!.query(`INSERT INTO application_borrowers (application_id, borrower_role, legal_name, date_of_birth, marital_status, citizenship_status) VALUES ($1, 'borrower', '', '1984-05-14', 'married', 'us_citizen')`, [app]);
  const writes: ((q: Queryable) => Promise<void>)[] = [];
  const eventsDb = new MemoryEventStore(clock); const cfDb = casefileFor(eventsDb, app);
  const rtDb: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(eventsDb, clock), services: { db: db!, deferWrite: (fn: (q: Queryable) => Promise<void>) => { writes.push(fn); } }, ports: {} };
  const outDb = await build(eventsDb, rtDb, cfDb);
  checkReported(eventsDb, outDb);
  assert.equal(outDb.persisted, true);
  assert.ok(outDb.request.document.gaps.some((g) => /\/PARTIES\/PARTY(\[1\])?\/INDIVIDUAL\/NAME\/FirstName$/.test(g.xpath)), `FirstName is among them: [${outDb.request.document.gaps.map((g) => g.xpath).join(", ")}]`);
  assert.ok(!outDb.request.document.gaps.some((g) => /BorrowerBirthDate$|MaritalStatusType$|CitizenshipResidencyType$/.test(g.xpath)), "the borrower's own columns are read (T9)");
  assert.equal(writes.length, 1); for (const w of writes) await db!.tx(w);
  const rows = await db!.query<{ required_missing: number; gaps: { code: string; xpath: string }[]; sha256: string }>(`SELECT d.required_missing, doc.metadata->'gaps' AS gaps, encode(d.sha256, 'hex') AS sha256 FROM du_documents d JOIN documents doc ON doc.id = d.document_id WHERE d.application_id = $1`, [app]);
  assert.equal(rows.length, 1); assert.equal(Number(rows[0]!.required_missing), outDb.required_missing); assert.equal(rows[0]!.sha256, outDb.sha256);
  assert.deepEqual(rows[0]!.gaps.map((g) => g.xpath), outDb.request.document.gaps.map((g) => g.xpath), "the du_documents row carries the gaps by XPath");
});
test("23.6-T6: Given a first submission, when emitted, then `AutomatedUnderwritingCaseIdentifier` is absent; given `applications.du_casefile_id = 1234567890` and `submission_number = 2`, then it is present with that value.", () => {
  const AUS = "AutomatedUnderwritingCaseIdentifier";
  const first = assembleDuDocument(refinanceFixtureGraph(REFI), CASEFILE, { submission_number: 1 });
  assert.ok(!text(first.bytes).includes(AUS), "absent on a first submission");
  const second = assembleDuDocument(refinanceFixtureGraph(REFI, { du_casefile_id: "1234567890" }), CASEFILE, { submission_number: 2 });
  const xml = text(second.bytes);
  assert.ok(xml.includes(`<${AUS}>1234567890</${AUS}>`), "present with DU's value on submission 2");
  assert.deepEqual(lint(xml), []);
  const loan = elements(parseXml(xml)).find((e) => e.el.name === "LOAN")!;
  assert.equal(attr(loan.el, "LoanRoleType"), "SubjectLoan");
  assert.ok(elements(loan.el).some((e) => e.path.endsWith("UNDERWRITING/AUTOMATED_UNDERWRITINGS/AUTOMATED_UNDERWRITING/AutomatedUnderwritingCaseIdentifier")), "on the subject loan, under UNDERWRITING/AUTOMATED_UNDERWRITINGS");
  // Rule 8 both ways: our aus_casefile_id never goes on the wire as DU's — the casefile_id given to the emitter is not in the document —
  // and a du_casefile_id on submission 1 can only have come from a prior submission, so it is refused.
  assert.ok(!xml.includes(CASEFILE.casefile_id));
  assert.throws(() => assembleDuDocument(refinanceFixtureGraph(REFI, { du_casefile_id: "1234567890" }), CASEFILE, { submission_number: 1 }), (e: unknown) => e instanceof DuEmitError && e.code === "DU_CASEFILE_ID_ON_FIRST_SUBMISSION");
  // A resubmission with no identifier yet: refused strictly, a gap under report (the FAKE port mints the id in 23.7).
  assert.throws(() => assembleDuDocument(refinanceFixtureGraph(REFI), CASEFILE, { submission_number: 2 }), (e: unknown) => e instanceof DuEmitError && e.code === "DU_REQUIRED_MISSING" && e.xpath.endsWith(AUS));
  const reported = assembleDuDocument(refinanceFixtureGraph(REFI), CASEFILE, { submission_number: 2 }, { conditionality: "report" });
  assert.ok(reported.gaps.some((g) => g.xpath.endsWith(AUS)));
  // buildDuRequest carries the same rule: submission 1 null, submission 2 the graph's du_casefile_id.
  const cf = { ...createCasefile(new MemoryEventStore(new FixedClock("2026-10-06T15:00:00.000Z")), { application_id: "APP-R", seller_number: "123456789", system_id_ref: "SYS-PARTNER-01", tsp_product_ref: "SM-TSP", score_model: "classic_fico", created_at: "2026-10-06T15:00:00.000Z" }).casefile, credit_association: association() };
  assert.equal(buildDuRequest(cf, { submission_type: "credit_and_underwriting", reason: "initial", built_at: "2026-10-06T15:00:00.000Z", snapshot: REFI, graph: refinanceFixtureGraph(REFI) }).automated_underwriting_case_identifier, null);
  assert.equal(buildDuRequest(cf, { submission_type: "underwriting_only", reason: "tolerance_breach", built_at: "2026-10-20T15:00:00.000Z", snapshot: REFI, graph: refinanceFixtureGraph(REFI, { du_casefile_id: FIXTURE_DU_CASEFILE_ID }), prior_submission_number: 1 }).automated_underwriting_case_identifier, FIXTURE_DU_CASEFILE_ID);
});
const association = () => [B1, B2].map((b) => ({ borrower_id: b.borrower_id, mode: "reissue" as const, credit_agency_code: "XAC01", reference_number: `REF-${b.borrower_id}`, report_type: "joint" as const, credit_report_id: "R-APP-R", score_model: "classic_fico" as const, expires_at: D("2027-02-05") }));
test("23.6-T7: Given the same graph emitted twice, then the two documents are byte-identical and `du_documents.sha256` is equal; given one asset's balance changes by one cent, then the hashes differ.", async () => {
  const a = assembleDuDocument(refinanceFixtureGraph(REFI), CASEFILE, FIRST);
  const b = assembleDuDocument(refinanceFixtureGraph(REFI), CASEFILE, FIRST);
  assert.deepEqual(Buffer.from(a.bytes), Buffer.from(b.bytes), "byte-identical");
  assert.equal(a.sha256, b.sha256); assert.equal(a.sha256, sha(a.bytes)); assert.match(a.sha256, /^[0-9a-f]{64}$/);
  // The bytes carry no instant (ABOUT_VERSION/CreatedDatetime is optional and omitted by the runtime): the hash is the content.
  assert.ok(!text(a.bytes).includes("CreatedDatetime"));
  // One asset's balance one cent higher: different bytes, different hash — and the document still validates.
  const cent = withValues(refinanceFixtureGraph(REFI), "asset:checking", (v) => { v["ASSET_DETAIL/AssetCashOrMarketValueAmount"] = 4_650_001n; });
  const c = assembleDuDocument(cent, CASEFILE, FIRST);
  assert.notEqual(c.sha256, a.sha256); assert.ok(text(c.bytes).includes("<AssetCashOrMarketValueAmount>46500.01</AssetCashOrMarketValueAmount>")); assert.ok(text(a.bytes).includes("<AssetCashOrMarketValueAmount>46500.00</AssetCashOrMarketValueAmount>"));
  assert.deepEqual(lint(c.bytes), []);
  if (skipDb) { console.log(`  (du_documents.sha256 assertion on the database skipped: ${skipDb})`); return; }
  const app = await newApplication();
  const events = new MemoryEventStore(new FixedClock("2026-10-06T15:00:00.000Z"));
  const at = "2026-10-06T15:00:00.000Z";
  const one = await db!.tx((q) => persistDuDocument(q, { application_id: app, casefile_id: CASEFILE.casefile_id, submission_number: 1, document: a, emitted_at: at }));
  const two = await db!.tx((q) => emitDuDocument(q, events, { graph: { ...refinanceFixtureGraph(REFI), application_id: app }, casefile: CASEFILE, submission: FIRST, emitted_at: "2026-10-07T15:00:00.000Z" }));
  const three = await db!.tx((q) => persistDuDocument(q, { application_id: app, casefile_id: CASEFILE.casefile_id, submission_number: 2, document: c, emitted_at: at }));
  const rows = await db!.query<{ id: string; sha256: string; document_id: string; doc_sha: string; byte_size: string; xml: string }>(`SELECT d.id, encode(d.sha256, 'hex') AS sha256, d.document_id::text AS document_id, doc.sha256 AS doc_sha, doc.byte_size::text AS byte_size, doc.metadata->>'xml' AS xml FROM du_documents d JOIN documents doc ON doc.id = d.document_id WHERE d.application_id = $1 ORDER BY d.created_at`, [app]);
  assert.equal(rows.length, 3);
  assert.equal(rows[0]!.sha256, rows[1]!.sha256, "a re-emission with identical bytes is a new row with the same hash"); assert.notEqual(rows[0]!.id, rows[1]!.id); assert.notEqual(rows[0]!.document_id, rows[1]!.document_id);
  assert.equal(rows[0]!.sha256, a.sha256); assert.equal(rows[0]!.doc_sha, a.sha256); assert.equal(Number(rows[0]!.byte_size), a.bytes.byteLength); assert.equal(sha(rows[1]!.xml), a.sha256, "the persisted text hashes to the row's sha256");
  assert.notEqual(rows[2]!.sha256, rows[0]!.sha256); assert.equal(rows[2]!.sha256, c.sha256);
  assert.equal(one.sha256, two.sha256); assert.equal(three.sha256, c.sha256);
  assert.equal(events.ofType("du.document.emitted").length, 1); assert.equal(events.ofType("du.document.emitted")[0]!.payload["sha256"], a.sha256); assert.equal(events.ofType("du.document.emitted")[0]!.applicationId, app);
  await assert.rejects(db!.query(`UPDATE du_documents SET emitted_at = now() WHERE id = $1`, [rows[0]!.id]), /append-only/);
});
test("23.6-T8: Given the 23.5 graph for the refinance fixture, when emitted, then `xlink:label` values are unique across the document and every `xlink:from`/`xlink:to` names a label the document contains.", () => {
  const document = assembleDuDocument(refinanceFixtureGraph(REFI), CASEFILE, FIRST);
  const root = parseXml(text(document.bytes));
  const labels = elements(root).map((e) => attr(e.el, "xlink:label")).filter((l): l is string => l !== undefined);
  assert.equal(labels.length, 11, `${labels.length} labelled containers: LOAN_1, two PARTY_n_ROLE, two ASSET_n, two LIABILITY_n, two EMPLOYER_n, two CURRENT_INCOME_ITEM_n`);
  assert.equal(new Set(labels).size, labels.length, "xlink:label values are unique across the document");
  assert.deepEqual([...new Set(labels)].sort(), [...document.labels.values()].sort(), "the labels the assembly reports are the labels in the bytes");
  const arcs = arcsOf(root);
  assert.equal(arcs.length, document.stats.relationship_count); assert.ok(arcs.length >= 8);
  for (const a of arcs) { assert.ok(labels.includes(a.from), `${a.from} is a label in the document`); assert.ok(labels.includes(a.to), `${a.to} is a label in the document`); }
  // Labels follow the stable sort (rule 1): PARTY_n / PARTY_n_ROLE by borrower ordinal, ASSET_n, LIABILITY_n by (created_at, id).
  assert.deepEqual(labels.filter((l) => /^PARTY_\d+_ROLE$/.test(l)), ["PARTY_1_ROLE", "PARTY_2_ROLE"]);
  assert.deepEqual(labels.filter((l) => l.startsWith("ASSET_")), ["ASSET_1", "ASSET_2"]); assert.deepEqual(labels.filter((l) => l.startsWith("LIABILITY_")), ["LIABILITY_1", "LIABILITY_2"]);
  assert.deepEqual(labels.filter((l) => l.startsWith("EMPLOYER_")), ["EMPLOYER_1", "EMPLOYER_2"]); assert.deepEqual(labels.filter((l) => l.startsWith("CURRENT_INCOME_ITEM_")), ["CURRENT_INCOME_ITEM_1", "CURRENT_INCOME_ITEM_2"]);
  // A PARTY with two ROLE containers would carry PARTY_1_ROLE twice — the XSD accepts that (23.6 Verified requirement), the emitter does not.
  const base = refinanceFixtureGraph(REFI);
  const twoRoles: DuGraph = { ...base, containers: [...base.containers, { kind: "ROLE", id: "role:B1:owner", created_at: "2026-10-05T14:59:59.000Z", parent: "party:B1", values: { "ROLE_DETAIL/PartyRoleType": "PropertyOwner" } }] };
  assert.throws(() => assembleDuDocument(twoRoles, CASEFILE, FIRST), (e: unknown) => e instanceof DuEmitError && e.code === "DU_LABEL_DUPLICATE" && /\/PARTIES\/PARTY\[1\]\/ROLES\/ROLE\[2\]$/.test(e.xpath) && /PARTY_1_ROLE/.test(e.detail));
  assert.throws(() => assembleDuDocument(twoRoles, CASEFILE, FIRST, { conditionality: "report" }), (e: unknown) => e instanceof DuEmitError && e.code === "DU_LABEL_DUPLICATE", "…under report too: a label is never a gap");
  // And a dangling arc in the graph is refused at assembly, never written.
  const dangling: DuGraph = { ...refinanceFixtureGraph(REFI), arcs: [...refinanceFixtureGraph(REFI).arcs, { id: "x", created_at: "2026-10-05T15:00:00.000Z", arcrole: "ASSET_IsAssociatedWith_ROLE", from: "asset:checking", to: "role:nobody" }] };
  assert.throws(() => assembleDuDocument(dangling, CASEFILE, FIRST), (e: unknown) => e instanceof DuEmitError && e.code === "DU_ARC_DANGLING");
});
test("23.6-T9: Given a wage income item with no employer, when emitted, then `EmploymentIncomeIndicator` is false and no employer arc is written for it.", async () => {
  // The projection (loadGraph's projectGraph over readDuGraph's rows): an application_income row with employer_id null is a
  // CURRENT_INCOME_ITEM with EmploymentIncomeIndicator false and no CURRENT_INCOME_ITEM_IsAssociatedWith_EMPLOYER arc; one
  // naming an employer is true with the arc.
  const created_at = "2026-10-05T14:00:00.000Z";
  const rows = {
    application_id: "00000000-0000-4000-8000-0000000000a1", du_casefile_id: null,
    borrowers: [{ id: "ab-1", borrower_ordinal: 1, borrower_role: "borrower", legal_name: "Ana Rivera", party_id: null, created_at, date_of_birth: null, marital_status: null, citizenship_status: null }],
    assets: [], liabilities: [], expenses: [], joint_credit_report_links: [], declarations: [], residences: [], invariants: {},
    employers: [{ id: "emp-1", application_id: "00000000-0000-4000-8000-0000000000a1", application_borrower_id: "ab-1", display_name: "Desert Ridge Medical Group", created_at }],
    income_items: [
      { id: "inc-wage-no-employer", application_id: "00000000-0000-4000-8000-0000000000a1", application_borrower_id: "ab-1", source_kind: "base", monthly_amount_cents: 400000n, employer_id: null, employment_income: false, created_at },
      { id: "inc-wage", application_id: "00000000-0000-4000-8000-0000000000a1", application_borrower_id: "ab-1", source_kind: "base", monthly_amount_cents: 800000n, employer_id: "emp-1", employment_income: true, created_at: "2026-10-05T14:00:01.000Z" },
    ],
  };
  const g = projectGraph(rows);
  const none = g.containers.find((c) => c.id === "inc-wage-no-employer")!; const some = g.containers.find((c) => c.id === "inc-wage")!;
  assert.equal(none.kind, "CURRENT_INCOME_ITEM"); assert.equal(none.values["CURRENT_INCOME_ITEM_DETAIL/EmploymentIncomeIndicator"], false); assert.equal(none.values["CURRENT_INCOME_ITEM_DETAIL/IncomeType"], "Base");
  assert.equal(some.values["CURRENT_INCOME_ITEM_DETAIL/EmploymentIncomeIndicator"], true);
  assert.deepEqual(g.arcs.filter((a) => a.arcrole === "CURRENT_INCOME_ITEM_IsAssociatedWith_EMPLOYER").map((a) => a.from), ["inc-wage"]);
  // Emitted: the refinance fixture with such an item on Borrower 1 — the indicator is false in the bytes, no arc names its label, and the document still validates.
  const base = refinanceFixtureGraph(REFI);
  const graph: DuGraph = { ...base, containers: [...base.containers, { kind: "CURRENT_INCOME_ITEM", id: "income:B1:second-job", created_at: "2026-10-05T14:59:00.000Z", parent: "role:B1", values: { "CURRENT_INCOME_ITEM_DETAIL/CurrentIncomeMonthlyTotalAmount": 125_000n, "CURRENT_INCOME_ITEM_DETAIL/EmploymentIncomeIndicator": false, "CURRENT_INCOME_ITEM_DETAIL/IncomeType": "Base" } }] };
  const document = assembleDuDocument(graph, CASEFILE, FIRST);
  assert.deepEqual(document.gaps, []);
  assert.deepEqual(lint(document.bytes), []);
  const root = parseXml(text(document.bytes));
  const label = document.labels.get("income:B1:second-job")!;
  const item = elements(root).find((e) => e.el.name === "CURRENT_INCOME_ITEM" && attr(e.el, "xlink:label") === label)!;
  assert.ok(item, `${label} is in the document`);
  assert.ok(elements(item.el).some((e) => e.el.name === "EmploymentIncomeIndicator" && e.el.text.trim() === "false"));
  const arcs = arcsOf(root);
  assert.equal(arcs.filter((a) => a.from === label || a.to === label).length, 0, "no employer arc for it");
  assert.equal(arcs.filter((a) => a.arcrole === "CURRENT_INCOME_ITEM_IsAssociatedWith_EMPLOYER").length, 2, "the two employed items keep theirs");
  assert.equal(document.stats.relationship_count, assembleDuDocument(base, CASEFILE, FIRST).stats.relationship_count);
  // The same through loadGraph on Postgres (readDuGraph's rows, 0127's tables): the item with employer_id null is read too
  // (readDuGraph lists only the arced ones), the indicator is false and no arc names it; and the borrower's own columns —
  // date_of_birth, marital_status, citizenship_status — reach BorrowerBirthDate, MaritalStatusType and
  // CitizenshipResidencyType (the last a borrower attribute, present with no du_declarations row), so none is a gap.
  if (skipDb) { console.log(`  (loadGraph assertion on the database skipped: ${skipDb})`); return; }
  const app = await newApplication();
  const ab = (await db!.query<{ id: string }>(`INSERT INTO application_borrowers (application_id, borrower_role, legal_name, date_of_birth, marital_status, citizenship_status) VALUES ($1, 'borrower', 'Ana Rivera', '1984-05-14', 'married', 'us_citizen') RETURNING id`, [app]))[0]!.id;
  const employer = (await db!.query<{ id: string }>(`INSERT INTO employers (application_id, application_borrower_id, identity_key, derived_from, name_key, display_name) VALUES ($1, $2, 'name:desert-ridge-medical-group', 'name', 'name:desert-ridge-medical-group', 'Desert Ridge Medical Group') RETURNING id`, [app, ab]))[0]!.id;
  const noEmployer = (await db!.query<{ id: string }>(`INSERT INTO application_income (application_id, application_borrower_id, source_kind, monthly_amount_cents, employer_id, employment_income) VALUES ($1, $2, 'base', 400000, NULL, false) RETURNING id`, [app, ab]))[0]!.id;
  const wage = (await db!.query<{ id: string }>(`INSERT INTO application_income (application_id, application_borrower_id, source_kind, monthly_amount_cents, employer_id, employment_income) VALUES ($1, $2, 'base', 800000, $3, true) RETURNING id`, [app, ab, employer]))[0]!.id;
  const loaded = await loadGraph(db!, app);
  const items = loaded.containers.filter((c) => c.kind === "CURRENT_INCOME_ITEM");
  assert.deepEqual(items.map((c) => [c.id, c.values["CURRENT_INCOME_ITEM_DETAIL/EmploymentIncomeIndicator"]]), [[noEmployer, false], [wage, true]]);
  assert.deepEqual(loaded.arcs.filter((a) => a.arcrole === "CURRENT_INCOME_ITEM_IsAssociatedWith_EMPLOYER").map((a) => [a.from, a.to]), [[wage, employer]]);
  const role = loaded.containers.find((c) => c.kind === "ROLE" && c.id === `role:${ab}`)!;
  assert.equal(role.values["BORROWER/BORROWER_DETAIL/BorrowerBirthDate"], "1984-05-14");
  assert.equal(role.values["BORROWER/BORROWER_DETAIL/MaritalStatusType"], "Married");
  assert.equal(role.values["BORROWER/DECLARATION/DECLARATION_DETAIL/CitizenshipResidencyType"], "USCitizen");
  assert.equal(Number((await db!.query<{ c: string }>(`SELECT count(*)::text AS c FROM du_declarations WHERE application_borrower_id = $1`, [ab]))[0]!.c), 0, "no du_declarations row: the citizenship is the borrower's own column");
  const reported = assembleDuDocument(withDeal(loaded, dealFromSnapshot({ ...REFI, borrowers: [B1] }, CASEFILE.system_id_ref)), CASEFILE, FIRST, { conditionality: "report" });
  for (const point of ["BORROWER_DETAIL/BorrowerBirthDate", "BORROWER_DETAIL/MaritalStatusType", "DECLARATION_DETAIL/CitizenshipResidencyType"]) assert.ok(!reported.gaps.some((g) => g.xpath.endsWith(point)), `${point} is not a gap: [${reported.gaps.map((g) => g.xpath).join(", ")}]`);
  const xml = text(reported.bytes);
  assert.ok(xml.includes("<BorrowerBirthDate>1984-05-14</BorrowerBirthDate>") && xml.includes("<MaritalStatusType>Married</MaritalStatusType>") && xml.includes("<CitizenshipResidencyType>USCitizen</CitizenshipResidencyType>"));
});
test("23.6-T10: Given `du:verify` run on a checkout with no `DU_SPEC_DIR`, then it re-derives every child sequence from the vendored chain, re-counts the arcs the samples exercise, checks every `Du*` CHECK constraint in the migrations against `DU_ENUMERATIONS`, reports the workbook check as skipped by name, and fails on any drift in `order.ts` or `arcroles.ts`.", () => {
  // The real verify, as `npm run du:verify` spawns it, with DU_SPEC_DIR absent from the environment: five lines, and
  // each names what it checked or what it skipped — never a green line over a diff that read nothing.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (k !== "DU_SPEC_DIR" && v !== undefined) env[k] = v;
  const result = spawnSync(process.execPath, [resolve(ROOT, "tools/build-du.mjs"), "--verify"], { cwd: ROOT, encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split("\n");
  assert.equal(lines.length, 5, result.stdout);
  assert.match(lines[0]!, /^✓ (\d+) du_\* enum CHECK\(s\) in db\/migrations match the DU Spec$/);
  assert.equal(lines[1], "✓ 227 child sequences in order.ts match the vendored MISMO chain");
  assert.equal(lines[2], "✓ 9 of 11 arcroles in arcroles.ts are exercised by the vendored samples, and no sample carries another");
  assert.equal(lines[3], "✓ 3 per-kind asset CHECK(s) admit exactly their section's 22 AssetType values");
  assert.equal(lines[4], "- skipped the workbook check (enums, lengths, cardinality, conditionality, and the arcroles' endpoints): DU_SPEC_DIR is not set");
  assert.doesNotMatch(result.stdout, /skipped the du_\* enum CHECK diff|skipped the per-kind asset CHECK diff/, "the two migration-reading checks ran");

  // "Every Du* CHECK constraint in the migrations": the count on the first line is the number of du_* columns whose
  // comment names a DU data point, and the migration reader finds them all — an IN list for each, no column with a
  // comment and no list, and the enum each maps to in DU_ENUMERATIONS.
  const found = duEnumChecksInMigrations(migrationSources(ROOT));
  const checked = Number(/^✓ (\d+) du_\*/.exec(lines[0]!)![1]);
  assert.equal(found.comments.size, checked);
  assert.ok(checked >= 17, `${checked} DU-commented columns`);
  for (const column of found.comments.keys()) assert.ok(found.lists.has(column), `${column} has an IN list`);
  const generated = parseGeneratedEnums(readFileSync(resolve(ROOT, "src/domain/underwriting/du/generated/enums.ts"), "utf8")).enumerations;
  assert.deepEqual(diffDuEnumChecks(found, generated), []);
  const columns = [...found.comments.keys()];
  for (const c of ["du_assets.asset_type", "du_liabilities.liability_type", "du_expenses.expense_type", "du_residences.residency_basis", "du_declarations.intent_to_occupy", "du_bankruptcy_filings.chapter", "du_owned_properties.disposition"]) assert.ok(columns.includes(c), c);

  // "Fails on any drift": a fabricated member in a du_* CHECK — the SecuredBorrowedFundsNotDeposited case, a value that
  // lived in a block labelled "generated" and was in no tab of the spec — is named, and so is a member dropped.
  const graph = duGraphMigrationPaths(ROOT);
  assert.equal(graph.length, 1, graph.join(", "));
  const sql = readFileSync(resolve(ROOT, graph[0]!), "utf8");
  const widened = sql.replace("'CashOnHand', 'Other', 'PendingNetSaleProceedsFromRealEstateAssets'", "'CashOnHand', 'Other', 'SecuredBorrowedFundsNotDeposited', 'PendingNetSaleProceedsFromRealEstateAssets'");
  assert.notEqual(widened, sql);
  const drift = diffDuEnumChecks(duEnumChecksInMigrations([{ file: graph[0]!, sql: widened }]), generated);
  assert.deepEqual(drift, ["du_assets.asset_type admits SecuredBorrowedFundsNotDeposited, which has no row in the DU Enumerations tab for AssetType (DuAssetType)."]);
  const narrowed = sql.replace("'LeasePayment', ", "");
  assert.notEqual(narrowed, sql);
  assert.deepEqual(diffDuEnumChecks(duEnumChecksInMigrations([{ file: graph[0]!, sql: narrowed }]), generated), ["du_liabilities.liability_type is missing LeasePayment, which the DU Enumerations tab carries for LiabilityType (DuLiabilityType)."]);
  // The per-kind partition: a value moved between kinds is a value admitted where the tab does not file it, and missing where it does.
  const sections = parseGeneratedAssetTypeSections(readFileSync(resolve(ROOT, "src/domain/underwriting/du/generated/enums.ts"), "utf8"));
  const moved = sql.replace("'GiftOfCash', 'GiftOfPropertyEquity', 'Grant'", "'GiftOfCash', 'GiftOfPropertyEquity', 'Grant', 'CashOnHand'");
  const problems = diffAssetTypeChecks(sections, assetTypeListsInMigration(moved, { path: graph[0]! }), generated.DuAssetType ?? []);
  assert.deepEqual(problems, ["du_assets_gift_or_grant_shape admits CashOnHand, which the DU Enumerations tab does not file under 4d.1."]);

  // Drift in order.ts: the committed table is clean; two children swapped in a copy is named by container (23.6-T11 drives the same edit end to end).
  const order = readFileSync(ORDER_TS, "utf8");
  assert.deepEqual(schemaOrderProblems(order).problems, []);
  const swapped = order.replace('    "INDIVIDUAL",\n    "LEGAL_ENTITY",', '    "LEGAL_ENTITY",\n    "INDIVIDUAL",');
  assert.notEqual(swapped, order);
  assert.ok(schemaOrderProblems(swapped).problems.length > 0);
  // Drift in arcroles.ts: the committed table's corpus column agrees with the eighteen samples arc for arc; flip one
  // arc's `exercised` and the re-count disagrees, which is what fails the run.
  const arcroles = parseGeneratedArcRoles(readFileSync(resolve(ROOT, "src/domain/underwriting/du/generated/arcroles.ts"), "utf8")) as Record<string, { arcrole: string; exercised: boolean }>;
  const corpus = arcRolesInCorpus() as Map<string, number>;
  assert.equal(Object.values(arcroles).filter((a) => a.exercised).length, 9);
  assert.equal(corpus.size, 9);
  for (const [name, arc] of Object.entries(arcroles)) assert.equal(arc.exercised, corpus.has(arc.arcrole), name);
  for (const uri of corpus.keys()) assert.ok(Object.values(arcroles).some((a) => a.arcrole === uri), uri);
  const flipped = { ...arcroles, ASSET_IsAssociatedWith_ROLE: { ...arcroles["ASSET_IsAssociatedWith_ROLE"]!, exercised: false } };
  assert.ok(Object.entries(flipped).some(([, arc]) => arc.exercised !== corpus.has(arc.arcrole)), "a flipped corpus column is drift the re-count sees");
});
test("23.6-T11: Given a hand edit to `generated/order.ts` that swaps two children, when `npm test` runs, then `du:verify` fails the build naming the container.", () => {
  // `npm test` reaches du:verify: it is the tail of the test script, after the audit ratchet and the name lint.
  const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.ok(pkg.scripts.test?.endsWith(" && npm run du:verify"), pkg.scripts.test);
  assert.equal(pkg.scripts["du:verify"], "node tools/build-du.mjs --verify");

  // The committed table is clean against the vendored chain, so any problem below is the hand edit's.
  const committed = readFileSync(ORDER_TS, "utf8");
  assert.deepEqual(schemaOrderProblems(committed).problems, []);

  // The hand edit, on a copy: PARTY's INDIVIDUAL and LEGAL_ENTITY swapped. The same pair sits adjacent under
  // EMPLOYER, so the swap is made inside the PARTY block alone — the failure has to name the container edited.
  const party = parseGeneratedOrder(committed).childOrder["PARTY"];
  assert.ok(party, "PARTY is in CHILD_ORDER");
  assert.equal(party.indexOf("LEGAL_ENTITY"), party.indexOf("INDIVIDUAL") + 1);
  const start = committed.indexOf('\n  "PARTY": [');
  assert.ok(start > 0, "the PARTY block is in order.ts");
  const end = committed.indexOf("\n  ]", start);
  const block = committed.slice(start, end);
  const swapped = block.replace('    "INDIVIDUAL",\n    "LEGAL_ENTITY",', '    "LEGAL_ENTITY",\n    "INDIVIDUAL",');
  assert.notEqual(swapped, block, "the edit matched the two children");
  const edited = committed.slice(0, start) + swapped + committed.slice(end);

  const scratch = mkdtempSync(join(tmpdir(), "du-order-"));
  try {
    const copy = join(scratch, "order.ts");
    writeFileSync(copy, edited);
    assert.deepEqual(parseGeneratedOrder(readFileSync(copy, "utf8")).childOrder["PARTY"], [
      "REFERENCE", "LEGAL_ENTITY", "INDIVIDUAL", "ADDRESSES", "LANGUAGES", "ROLES", "TAXPAYER_IDENTIFIERS", "EXTENSION",
    ]);
    const { problems } = schemaOrderProblems(readFileSync(copy, "utf8"));
    assert.ok(problems.length > 0, "du:verify fails on the edited copy");
    assert.ok(problems.some((p) => /^PARTY: the schema chain now declares REFERENCE, INDIVIDUAL, LEGAL_ENTITY/.test(p)), problems.join("\n"));
    assert.ok(problems.every((p) => !p.startsWith("EMPLOYER")), "only the container that was edited is named");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
test("23.6-T12: Given a request built from the refinance fixture, then `request_hash` equals the SHA-256 of the transmitted bytes and 23.1's duplicate-suppression test (23.1-T1's second identical build) still passes.", () => {
  const events = new MemoryEventStore(new FixedClock("2026-10-06T15:00:00.000Z"));
  const cf: DuCasefile = { ...createCasefile(events, { application_id: "APP-R", seller_number: "123456789", system_id_ref: "SYS-PARTNER-01", tsp_product_ref: "SM-TSP", score_model: "classic_fico", created_at: "2026-10-06T15:00:00.000Z" }).casefile, credit_association: association(), status: "credit_associated" };
  const build = (at: string, snapshot: UladSnapshot = REFI) => buildDuRequest(cf, { submission_type: "credit_and_underwriting", reason: "initial", built_at: at, snapshot, graph: refinanceFixtureGraph(snapshot) });
  const r = build("2026-10-06T15:00:00.000Z");
  // The hash is the bytes: SHA-256 of the transmitted document's UTF-8, and the document is the XML (not JSON).
  assert.equal(r.request_hash, sha(Buffer.from(r.xml_document, "utf8"))); assert.equal(r.request_hash, r.document.sha256);
  assert.ok(r.xml_document.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<MESSAGE xmlns="http://www.mismo.org/residential/2009/schemas"')); assert.equal(r.mismo_version, "3.4-B324");
  assert.throws(() => JSON.parse(r.xml_document), "xml_document is no longer canonical JSON");
  assert.deepEqual(lint(r.xml_document), []); assert.equal(r.document.required_missing, 0); assert.match(r.document_id, /^[0-9a-f-]{36}$/);
  assert.equal(r.document.borrower_count, 2); assert.ok(r.document.container_count >= 12); assert.ok(r.document.relationship_count >= 8);
  // 23.1-T1's second identical build — a day later, same snapshot — hashes the same and is suppressed (23.1 rule 3).
  const again = build("2026-10-07T15:00:00.000Z");
  assert.equal(again.request_hash, r.request_hash);
  const prior: DuSubmission = { submission_id: "s1", casefile_id: cf.casefile_id, application_id: cf.application_id, submission_number: 1, submission_type: "credit_and_underwriting", reason: "initial", request_document_id: r.document_id, request_hash: r.request_hash, du_version: "12.1", du_release_applied: "2026_09_25", return_file_types: r.return_file_types,
    findings_document_id: null, findings_json_document_id: null, findings_pdf_document_id: null, submitted_at: r.built_at, acked_at: r.built_at, findings_received_at: null, status: "acked", error_code: null, error_message: null, recommendation: null, messages: [], risk_factors: {}, validation_results: [], value_acceptance_offer: null, mi_requirement: null,
    dti_du: null, ltv_du: null, cltv_du: null, hcltv_du: null, reserves_required_cents: null, total_funds_to_verify_cents: null, qualifying_rate: null, note_rate: REFI.note_rate_pct, loan_amount_cents: REFI.loan_amount_cents, is_final: false, closed_loan_snapshot_hash: null, findings_hash: null, snapshot: REFI, rationale: null, submitted_via: "di_channel", agent_run_id: null, du_casefile_id: null };
  const scif = { borrowers: REFI.borrowers.map((b) => ({ id: b.borrower_id, scif_presented_at: "2026-10-05T16:00:00.000Z" })) };
  assert.throws(() => assertSubmittable({ ...cf, status: "findings_received", submission_count: 1 }, { request: again, at: again.built_at, prior: [prior], projected_note_date: D("2026-11-06"), scif_facts: scif }), (e: unknown) => e instanceof DuRefused && e.error_code === "DUPLICATE_REQUEST_SUPPRESSED");
  // …and a $450.00 liability (23.1-T2) is a different document, a different hash, not suppressed.
  const changed = build("2026-10-20T15:00:00.000Z", { ...REFI, total_obligations_cents: REFI.total_obligations_cents + 45_000n });
  assert.notEqual(changed.request_hash, r.request_hash); assert.ok(changed.xml_document.includes("<LiabilityMonthlyPaymentAmount>5010.00</LiabilityMonthlyPaymentAmount>"));
  assert.doesNotThrow(() => assertSubmittable({ ...cf, status: "findings_received", submission_count: 1 }, { request: changed, at: changed.built_at, prior: [prior], projected_note_date: D("2026-11-06"), scif_facts: scif }));
});
