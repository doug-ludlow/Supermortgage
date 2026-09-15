// 23.7 Preflight: what DU rejects that the schema accepts, and the port contract for a real submission
// spec/sections/23-desktop-underwriter-and-the-credit-decision/23-7-preflight-and-the-du-port-contract.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
//
// The preflight is pure (du/preflight.ts runDuPreflight over bytes, graph, casefile, submission), so every case runs on
// bytes in memory: the eighteen samples re-emitted through the test-only loader (T1), bad documents made by mutating a
// good one's bytes (T2–T5 — and each is also run through xmllint, because "the same document validates against the XSD
// chain" is the point), the refinance fixture's graph edited before emission (T6, T7, T11), and 23.1's `submit` over a
// bus that carries the emission and the refusal (T10). The gate itself is the registry's row driven by the kernel's
// TimerEngine (T1). The database half runs against this suite's own database, every migration applied, when Postgres
// is reachable (skipped with a note otherwise): du_preflight_results — the row per run, passing or not, read back by
// du_documents id, documents id and application, and 0136's append-only trigger (T10); the ingest's write of
// applications.du_casefile_id, decided from the column as read before transmit and deferred into the command's commit
// as the runtime does it, with 0127's write-once trigger the backstop (T9 — the in-memory half of the same rule runs
// regardless). The port half (rule 9): the FAKE in src/infra/integrations/du.ts refuses bytes xmllint refuses (T8), and
// a rejection is a returned `error` submission, never a throw, so the row and du.submission.errored persist.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MemoryEventStore, FixedClock } from "../../kernel/events/index.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { EscalationService } from "../../app/escalations.ts";
import { connect, reachable, type Db, type Queryable } from "../../infra/db/client.ts";
import { xmllintErrorsOf } from "../../infra/integrations/du-schema/index.ts";
import { DuTransportError, FakeDuPort, fakeDuCasefileId, sha256Hex } from "../../infra/integrations/du.ts";
import { DU_ARCROLES } from "./du/generated/arcroles.ts";
import { assembleDuDocument, emptyGraph, withDeal, type DuArc, type DuContainer, type DuGraph } from "./du/emit.ts";
import { emitDuDocumentEmitted, persistDuDocument } from "./du/persist.ts";
import { DU_PREFLIGHT_CODES, DU_PREFLIGHT_PASSED, DU_PREFLIGHT_REFUSED, emitDuPreflight, persistDuPreflight, preflightGate, readDuPreflight, runDuPreflight, type PreflightResult } from "./du/preflight.ts";
import { loadSample, sampleNames } from "./fixtures/du-sample-loader.ts";
import { FIXTURE_DU_CASEFILE_ID, refinanceFixtureGraph } from "./fixtures/du-refinance-fixture.ts";
import { buildDuRequest, buildDuRequestWithDocument, createCasefile, dealFromSnapshot, DuRefused, duSubmitRequest, recordDuCasefileId, submitCasefile, type UladSnapshot } from "./ops-23-1.ts";

// ───────────────────────────────────────────────────────────── fixtures
const B1 = { borrower_id: "B1", last_name: "Rivera", suffix: null, ssn_last4: "1234" };
const B2 = { borrower_id: "B2", last_name: "Rivera", suffix: null, ssn_last4: "5678" };
const REFI: UladSnapshot = { application_id: "APP-R", loan_purpose: "limited_cash_out_refinance", occupancy: "principal_residence", product: "fixed_30", amortization: "fixed", loan_term: 360, property_type: "sfr_detached", sales_price_cents: null, appraised_value_cents: 80_000_000n, loan_amount_cents: 56_000_000n,
  note_rate_pct: "6.125", qualifying_income_cents: 1_200_000n, total_obligations_cents: 456_000n, borrowers: [B1, B2], max_ltv_pct: "95.00" };
/** 23.1's casefile credentials (harness values): the partner's seller number with SM's TSP identity. */
const CREDENTIALS = { seller_number: "123456789", system_id_ref: "SYS-PARTNER-01", tsp_product_ref: "SM-TSP" };
const CASEFILE = { casefile_id: "casefile:refi", ...CREDENTIALS };
const FIRST = { submission_number: 1 };
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const lint = (xml: string): string[] => xmllintErrorsOf(xml);
const failed = (r: PreflightResult, code: string) => r.checks.find((c) => c.code === code && !c.passed);
/** DI-C01 re-emitted: the good document every mutation starts from. */
const good = (): string => { const s = loadSample("DI-C01"); return text(assembleDuDocument(s.graph, s.casefile, s.submission).bytes); };
const mutate = (xml: string, from: string | RegExp, to: string): string => { const out = xml.replace(from, to); assert.notEqual(out, xml, `mutation ${String(from)} changed nothing`); return out; };
const SAMPLE_GRAPH = { du_casefile_id: null };
const scifFactsOf = (s: UladSnapshot) => ({ borrowers: s.borrowers.map((b) => ({ id: b.borrower_id, scif_presented_at: "2026-10-05T16:00:00.000Z" })) });

// ───────────────────────────────────────────────────────────── the database half (T9): own database, every migration
const BASE_URL = process.env["TEST_DATABASE_URL"] ?? "postgresql://sm:sm@localhost/supermortgage_test";
const DB_URL = ((): string => { const u = new URL(BASE_URL); u.pathname = `${u.pathname}_23_7`; return u.toString(); })();
const ADMIN_URL = ((): string => { const u = new URL(DB_URL); u.pathname = "/postgres"; return u.toString(); })();
const up = await reachable(ADMIN_URL);
if (!up && process.env["REQUIRE_DB"]) throw new Error(`REQUIRE_DB set but ${ADMIN_URL} is not reachable`);
const skipDb = up ? false : `no Postgres at ${ADMIN_URL}`;
let db: Db | null = null;
test.before(async () => {
  if (skipDb) return;
  const name = new URL(DB_URL).pathname.slice(1);
  const a = connect(ADMIN_URL); await a.query(`DROP DATABASE IF EXISTS ${name}`); await a.query(`CREATE DATABASE ${name}`); await a.end();
  execFileSync(fileURLToPath(new URL("../../../db/migrate.sh", import.meta.url)), { env: { ...process.env, DATABASE_URL: DB_URL }, stdio: "pipe" });
  db = connect(DB_URL);
});
test.after(async () => { if (db) await db.end(); });
async function newApplication(): Promise<string> {
  const partner = (await db!.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name) VALUES ('servicer', 'FAKE Partner 23.7') RETURNING id`))[0]!.id;
  return (await db!.query<{ id: string }>(`INSERT INTO applications (partner_party_id, channel, transaction_type, occupancy) VALUES ($1, 'organic', 'limited_cash_out', 'primary') RETURNING id`, [partner]))[0]!.id;
}
const column = async (app: string): Promise<string | null> => (await db!.query<{ du_casefile_id: string | null }>(`SELECT du_casefile_id FROM applications WHERE id = $1`, [app]))[0]!.du_casefile_id;

test("23.7-T1: Given each of the eighteen samples re-emitted (23.6-T1), when preflight runs, then every check passes and `SM_DU_PREFLIGHT_GATE` opens.", () => {
  const names = sampleNames();
  assert.equal(names.length, 18, names.join(", "));
  for (const name of names) {
    const sample = loadSample(name);
    const document = assembleDuDocument(sample.graph, sample.casefile, sample.submission);
    const r = runDuPreflight(document.bytes, sample.graph, { ...sample.casefile, ...CREDENTIALS }, sample.submission);
    assert.ok(r.passed, `${name}: ${r.checks.filter((c) => !c.passed).map((c) => `${c.code} @ ${c.xpath}: ${c.detail}`).join("; ")}`);
    assert.equal(r.refusal, null);
    assert.deepEqual(r.checks.map((c) => c.code), [...DU_PREFLIGHT_CODES], `${name}: every check ran, in the spec's order, credentials first`);
    assert.ok(r.checks.every((c) => c.passed));
  }
  // The gate: the registry row (not_before_gate, trigger du.document.emitted, satisfied du.preflight.passed) driven by the kernel's
  // engine — armed by 23.6's emission for the application, satisfied by the preflight's pass for the same application, nothing else.
  const clock = new FixedClock("2026-10-06T15:00:00.000Z"); const events = new MemoryEventStore(clock);
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["23.7"] });
  const sample = loadSample("DI-C04");
  const document = assembleDuDocument(sample.graph, sample.casefile, sample.submission);
  const application_id = sample.graph.application_id;
  emitDuDocumentEmitted(events, { application_id, casefile_id: sample.casefile.casefile_id, submission_number: 1, document, document_id: "doc-1", du_document_id: "du-doc-1", emitted_at: clock.now() });
  const armed = timers.byCode("SM_DU_PREFLIGHT_GATE");
  assert.equal(armed.length, 1); assert.equal(armed[0]!.status, "armed"); assert.equal(armed[0]!.subject.id, application_id);
  assert.equal(preflightGate(events, { document_id: "doc-1", sha256: document.sha256 }).state, "not_run");
  const r = runDuPreflight(document.bytes, sample.graph, { ...sample.casefile, ...CREDENTIALS }, sample.submission);
  const e = emitDuPreflight(events, { application_id, du_document_id: "du-doc-1", document_id: "doc-1", sha256: document.sha256, result: r, ran_at: clock.now() });
  assert.equal(e.type, DU_PREFLIGHT_PASSED); assert.equal(e.payload["document_id"], "du-doc-1"); assert.equal((e.payload["checks"] as unknown[]).length, DU_PREFLIGHT_CODES.length);
  assert.equal(armed[0]!.status, "satisfied", "du.preflight.passed opens SM_DU_PREFLIGHT_GATE");
  assert.equal(events.ofType("timer.satisfied").filter((t) => t.payload["code"] === "SM_DU_PREFLIGHT_GATE").length, 1);
  const gate = preflightGate(events, { document_id: "doc-1", sha256: document.sha256 });
  assert.equal(gate.open, true); assert.equal(gate.state, "passed");
});

test("23.7-T2: Given a document whose `RELATIONSHIP` names an `xlink:to` label not in the document, when preflight runs, then it is refused with `DU_PREFLIGHT_DANGLING_ARC` naming the arc — and the same document validates against the XSD chain.", () => {
  const xml = mutate(good(), /(<RELATIONSHIP [^>]*xlink:to=")([A-Z_0-9]+)(")/, "$1NOBODY_9$3");
  assert.deepEqual(lint(xml), [], "the XSD accepts a dangling xlink:to");
  const r = runDuPreflight(xml, SAMPLE_GRAPH, CASEFILE, FIRST);
  assert.equal(r.passed, false);
  assert.equal(r.refusal?.code, "DU_PREFLIGHT_DANGLING_ARC");
  assert.match(r.refusal!.xpath, /\/DEAL\/RELATIONSHIPS\/RELATIONSHIP(\[1\])?$/, "the arc is named by its XPath");
  assert.match(r.refusal!.detail, /xlink:to="NOBODY_9" names no label/);
  assert.match(r.refusal!.rule, /rule 1/);
  assert.ok(failed(r, "DU_PREFLIGHT_DANGLING_ARC")); assert.ok(!failed(r, "DU_PREFLIGHT_DUPLICATE_LABEL"));
  assert.equal(r.checks.length, DU_PREFLIGHT_CODES.length, "every other check still ran and is recorded");
});

test("23.7-T3: Given a document with two containers labelled `ASSET_1`, then `DU_PREFLIGHT_DUPLICATE_LABEL`; given an arcrole URI not among the eleven, then `DU_PREFLIGHT_UNKNOWN_ARCROLE`; given `UNDERWRITING_VERIFICATION_IsAssociatedWith_ASSET`, then `DU_PREFLIGHT_DISPUTED_ARC` — each while the XSD chain validates the document.", () => {
  const base = good();
  assert.ok(base.includes('xlink:label="ASSET_2"'), "DI-C01 carries at least two assets");
  // The second asset relabelled ASSET_1 everywhere it is named (its label and its arcs), so nothing dangles and the label is what is wrong.
  const dup = mutate(base, /"ASSET_2"/g, '"ASSET_1"');
  assert.deepEqual(lint(dup), [], "the XSD accepts a duplicate xlink:label");
  const r1 = runDuPreflight(dup, SAMPLE_GRAPH, CASEFILE, FIRST);
  assert.equal(r1.refusal?.code, "DU_PREFLIGHT_DUPLICATE_LABEL"); assert.match(r1.refusal!.detail, /xlink:label="ASSET_1" is carried by .*ASSET\[1\] and .*ASSET\[2\]/);

  const unknown = mutate(base, /xlink:arcrole="urn:fdc:mismo.org:2009:residential\/ASSET_IsAssociatedWith_ROLE"/, 'xlink:arcrole="urn:fdc:mismo.org:2009:residential/ASSET_IsOwnedBy_PERSON"');
  assert.deepEqual(lint(unknown), [], "the XSD accepts an invented arcrole URI");
  const r2 = runDuPreflight(unknown, SAMPLE_GRAPH, CASEFILE, FIRST);
  assert.equal(r2.refusal?.code, "DU_PREFLIGHT_UNKNOWN_ARCROLE"); assert.match(r2.refusal!.detail, /ASSET_IsOwnedBy_PERSON" is not one of the 11/);
  assert.equal(Object.keys(DU_ARCROLES).length, 11);

  const disputedUri = DU_ARCROLES["UNDERWRITING_VERIFICATION_IsAssociatedWith_ASSET"]!.arcrole;
  assert.ok(DU_ARCROLES["UNDERWRITING_VERIFICATION_IsAssociatedWith_ASSET"]!.to.disputed, "the table marks the arc disputed");
  const disputed = mutate(base, /xlink:arcrole="urn:fdc:mismo.org:2009:residential\/ASSET_IsAssociatedWith_ROLE"/, `xlink:arcrole="${disputedUri}"`);
  assert.deepEqual(lint(disputed), [], "the XSD accepts a disputed arcrole");
  const r3 = runDuPreflight(disputed, SAMPLE_GRAPH, CASEFILE, FIRST);
  assert.equal(r3.refusal?.code, "DU_PREFLIGHT_DISPUTED_ARC"); assert.match(r3.refusal!.detail, /UNDERWRITING_VERIFICATION_IsAssociatedWith_ASSET is disputed/);
  assert.ok(!failed(r3, "DU_PREFLIGHT_UNKNOWN_ARCROLE"), "a disputed arcrole is one of the eleven — it is refused for being disputed, not unknown");
});

test("23.7-T4: Given a document with five `PARTY` containers each holding a borrower `ROLE`, when preflight runs, then `DU_PREFLIGHT_BORROWER_COUNT`; given none, then `DU_PREFLIGHT_NOTHING_TO_UNDERWRITE`.", () => {
  // Five borrowers on the refinance fixture: five PARTY containers, each with a Borrower ROLE. The emitter writes it (the XSD allows it).
  const five: UladSnapshot = { ...REFI, borrowers: [B1, B2, { borrower_id: "B3", last_name: "Rivera", suffix: null, ssn_last4: "9012" }, { borrower_id: "B4", last_name: "Rivera", suffix: "Jr", ssn_last4: "3456" }, { borrower_id: "B5", last_name: "Rivera", suffix: null, ssn_last4: "7890" }] };
  const doc5 = assembleDuDocument(refinanceFixtureGraph(five), CASEFILE, FIRST);
  assert.equal(doc5.stats.borrower_count, 5);
  const xml5 = text(doc5.bytes);
  assert.deepEqual(lint(xml5), [], "the XSD accepts five borrowers");
  const r5 = runDuPreflight(xml5, SAMPLE_GRAPH, CASEFILE, FIRST);
  assert.equal(r5.refusal?.code, "DU_PREFLIGHT_BORROWER_COUNT"); assert.match(r5.refusal!.detail, /5 borrower ROLEs; DU allows four/); assert.match(r5.refusal!.xpath, /PARTY\[5\]\/ROLES\/ROLE$/);
  // None: the deal alone — the subject LOAN and COLLATERAL from 23.1's snapshot, no PARTY at all (assembled with rule 4 reporting, since the
  // borrower points are absent). Nobody to underwrite.
  const none = withDeal(emptyGraph("APP-R"), dealFromSnapshot(REFI, CREDENTIALS.system_id_ref));
  const doc0 = assembleDuDocument(none, CASEFILE, FIRST, { conditionality: "report" });
  assert.equal(doc0.stats.borrower_count, 0);
  const xml0 = text(doc0.bytes);
  assert.deepEqual(lint(xml0), [], "the XSD accepts a document with no PARTY");
  const r0 = runDuPreflight(xml0, SAMPLE_GRAPH, CASEFILE, FIRST);
  assert.equal(r0.refusal?.code, "DU_PREFLIGHT_NOTHING_TO_UNDERWRITE"); assert.match(r0.refusal!.detail, /no PARTY holds a borrower ROLE/);
  assert.ok(!failed(r0, "DU_PREFLIGHT_BORROWER_COUNT"), "zero borrowers is nothing to underwrite, not a count over four");
});

test("23.7-T5: Given a document whose `RELATIONSHIPS` container has been removed while `ASSET` containers remain, then `DU_PREFLIGHT_NO_GRAPH`.", () => {
  const xml = mutate(good(), /\s*<RELATIONSHIPS[^>]*>[\s\S]*?<\/RELATIONSHIPS>/, "");
  assert.ok(xml.includes('xlink:label="ASSET_1"') && !xml.includes("<RELATIONSHIP"), "the assets remain; the graph is gone");
  assert.deepEqual(lint(xml), [], "the XSD accepts a document with no RELATIONSHIPS container");
  const r = runDuPreflight(xml, SAMPLE_GRAPH, CASEFILE, FIRST);
  assert.equal(r.refusal?.code, "DU_PREFLIGHT_NO_GRAPH");
  assert.equal(r.refusal!.xpath, "MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL/RELATIONSHIPS");
  assert.match(r.refusal!.detail, /owned container\(s\) .*ASSET_1.* and no RELATIONSHIPS container/);
  assert.ok(failed(r, "DU_PREFLIGHT_ORPHAN"), "with no graph every owned container is also an orphan; NO_GRAPH is named first (rule 1 before rule 3)");
  assert.ok(!failed(r, "DU_PREFLIGHT_DANGLING_ARC"), "no arcs, nothing dangles");
});

test("23.7-T6: Given two `ASSET` containers with the same institution, subtype and last4 owned by different borrowers on one application, then `DU_PREFLIGHT_DUPLICATE_ASSET` naming both labels.", () => {
  // The joint checking account (Desert Sun Credit Union, CheckingAccount, 44-118822) is owned by both Riveras in the fixture; a second
  // statement of the same account, entered under Luis alone, is the joint-account double count 22.4 reconciles.
  const g = refinanceFixtureGraph(REFI);
  const checking = g.containers.find((c) => c.id === "asset:checking")!;
  const twin: DuContainer = { ...checking, id: "asset:checking-again", created_at: "2026-10-05T14:59:00.000Z" };
  const arc: DuArc = { id: "owner:asset:checking-again:role:B2", created_at: "2026-10-05T14:59:01.000Z", arcrole: "ASSET_IsAssociatedWith_ROLE", from: "asset:checking-again", to: "role:B2" };
  const doubled: DuGraph = { ...g, containers: [...g.containers, twin], arcs: [...g.arcs, arc] };
  const doc = assembleDuDocument(doubled, CASEFILE, FIRST);
  const r = runDuPreflight(doc.bytes, doubled, CASEFILE, FIRST);
  assert.equal(r.refusal?.code, "DU_PREFLIGHT_DUPLICATE_ASSET");
  const a = doc.labels.get("asset:checking")!, b = doc.labels.get("asset:checking-again")!;
  assert.ok(r.refusal!.detail.includes(a) && r.refusal!.detail.includes(b), `both labels named: ${r.refusal!.detail}`);
  assert.match(r.refusal!.detail, /Desert Sun Credit Union CheckingAccount …8822/);
  // The same account restated under the same owners is not the double count across owners (a re-statement 22.4 collapses; DU sees one owner set).
  const sameOwners: DuGraph = { ...g, containers: [...g.containers, twin], arcs: [...g.arcs, arc, { ...arc, id: "owner:asset:checking-again:role:B1", to: "role:B1" }] };
  const r2 = runDuPreflight(assembleDuDocument(sameOwners, CASEFILE, FIRST).bytes, sameOwners, CASEFILE, FIRST);
  assert.ok(!failed(r2, "DU_PREFLIGHT_DUPLICATE_ASSET"));
  // The fixture itself, and DI-C09's two two-owner assets, are not duplicates.
  assert.ok(!failed(runDuPreflight(assembleDuDocument(g, CASEFILE, FIRST).bytes, g, CASEFILE, FIRST), "DU_PREFLIGHT_DUPLICATE_ASSET"));
});

test("23.7-T7: Given `submission_number = 1` and an `AutomatedUnderwritingCaseIdentifier` present, then `DU_PREFLIGHT_CASEFILE_ID`; given `submission_number = 2` and the identifier absent or different from `applications.du_casefile_id`, then the same code.", () => {
  const AUS = /AutomatedUnderwritingCaseIdentifier/;
  // The identifier on the wire (a submission-2 emission with DU's identifier) presented as submission 1.
  const withId = refinanceFixtureGraph(REFI, { du_casefile_id: FIXTURE_DU_CASEFILE_ID });
  const doc2 = assembleDuDocument(withId, CASEFILE, { submission_number: 2 });
  assert.match(text(doc2.bytes), AUS);
  const r1 = runDuPreflight(doc2.bytes, { du_casefile_id: null }, CASEFILE, FIRST);
  assert.equal(r1.refusal?.code, "DU_PREFLIGHT_CASEFILE_ID"); assert.match(r1.refusal!.detail, /submission 1 carries AutomatedUnderwritingCaseIdentifier 1234567890/); assert.match(r1.refusal!.xpath, /LOANS\/LOAN\/UNDERWRITING\/AUTOMATED_UNDERWRITINGS\/AUTOMATED_UNDERWRITING\/AutomatedUnderwritingCaseIdentifier$/);
  // Submission 2 with the identifier absent (a first-submission emission) — applications.du_casefile_id holds DU's.
  const doc1 = assembleDuDocument(refinanceFixtureGraph(REFI), CASEFILE, FIRST);
  assert.doesNotMatch(text(doc1.bytes), AUS);
  const r2 = runDuPreflight(doc1.bytes, { du_casefile_id: FIXTURE_DU_CASEFILE_ID }, CASEFILE, { submission_number: 2 });
  assert.equal(r2.refusal?.code, "DU_PREFLIGHT_CASEFILE_ID"); assert.match(r2.refusal!.detail, /resubmission and carries no AutomatedUnderwritingCaseIdentifier \(applications.du_casefile_id = 1234567890\)/);
  // Submission 2 with an identifier that is not applications.du_casefile_id.
  const r3 = runDuPreflight(doc2.bytes, { du_casefile_id: "9999999999" }, CASEFILE, { submission_number: 2 });
  assert.equal(r3.refusal?.code, "DU_PREFLIGHT_CASEFILE_ID"); assert.match(r3.refusal!.detail, /1234567890 on the wire; applications.du_casefile_id is 9999999999/);
  // And the two that pass: submission 1 without, submission 2 with DU's own.
  assert.ok(runDuPreflight(doc1.bytes, { du_casefile_id: null }, CASEFILE, FIRST).passed);
  assert.ok(runDuPreflight(doc2.bytes, withId, CASEFILE, { submission_number: 2 }).passed);
});

test("23.7-T8: Given the FAKE port receives a document that fails `xmllint` against the chain, then it answers `DuTransportError` with status 400 and records no submission.", async () => {
  const clock = new FixedClock("2026-10-06T15:00:00.000Z"); const port = new FakeDuPort(clock);
  const bytesOf = (xml: string) => new TextEncoder().encode(xml);
  const submit = (xml: string, submission_number = 1) => { const document_bytes = bytesOf(xml); return { document_bytes, sha256: sha256Hex(document_bytes), casefile_id: CASEFILE.casefile_id, submission_number, seller_number: CREDENTIALS.seller_number, system_id_ref: CREDENTIALS.system_id_ref }; };
  // An enumeration the chain refuses (PartyRoleType "Borrowerr") — every preflight check would pass over it; the XSD is the one that catches it.
  const bad = mutate(good(), /<PartyRoleType>Borrower<\/PartyRoleType>/, "<PartyRoleType>Borrowerr</PartyRoleType>");
  const diagnostics = lint(bad);
  assert.ok(diagnostics.length > 0, "xmllint refuses the document");
  await assert.rejects(port.submit(submit(bad)), (e: unknown) => e instanceof DuTransportError && e.status === 400 && /does not validate against the DU schema chain/.test(e.message) && e.message.includes(diagnostics[0]!.slice(0, 40)));
  assert.equal(port.requests.length, 0, "records no submission");
  assert.equal(port.refused.length, 1); assert.equal(port.refused[0]!.status, 400); assert.deepEqual(port.refused[0]!.errors, diagnostics, "the xmllint result is the FAKE's evidence (Audit and evidence)");
  await assert.rejects(port.fetchFindings(fakeDuCasefileId(CASEFILE.casefile_id), 1), (e: unknown) => e instanceof DuTransportError && e.status === 404, "nothing to fetch findings for");
  // Bytes whose hash is not the one carried are refused the same way — the hash is the bytes (23.6 rule 6).
  await assert.rejects(port.submit({ ...submit(good()), sha256: "0".repeat(64) }), (e: unknown) => e instanceof DuTransportError && e.status === 400 && /sha256/.test(e.message));
  assert.equal(port.requests.length, 0);
  // The same document, valid, is acknowledged: a deterministic ten-digit casefile identifier on submission 1, echoed on submission 2.
  const ack = await port.submit(submit(good()));
  assert.match(ack.du_casefile_id, /^[1-9]\d{9}$/); assert.equal(ack.du_casefile_id, fakeDuCasefileId(CASEFILE.casefile_id)); assert.equal(ack.acked_at, clock.now());
  assert.equal((await port.submit(submit(good(), 2))).du_casefile_id, ack.du_casefile_id);
  assert.notEqual(fakeDuCasefileId("casefile:other"), ack.du_casefile_id);
  assert.equal(port.requests.length, 2);
  // Through 23.1's submit: a 400 is DU refusing the document, not the channel — no backoff, no outage, no du.submitted; DU_REJECTED on the error path.
  // The rejection is a RETURNED result (like the outage), never a throw: the du_submissions row moves to `error` "without a transmission"
  // and du.submission.errored persists with the command (a handler that throws persists nothing — src/infra/db/unit-of-work.ts).
  const events = new MemoryEventStore(clock);
  const cf = createCasefile(events, { application_id: REFI.application_id, ...CREDENTIALS, score_model: "classic_fico", created_at: clock.now() }).casefile;
  const { request, document } = buildDuRequestWithDocument(cf, { submission_type: "credit_only", reason: "initial", built_at: clock.now(), snapshot: REFI, graph: refinanceFixtureGraph(REFI) });
  const tampered = mutate(request.xml_document, /<PartyRoleType>Borrower<\/PartyRoleType>/, "<PartyRoleType>Borrowerr</PartyRoleType>");
  const port2 = new FakeDuPort(clock);
  // No emission preceded the tampered request, so submit preflights it itself before the port sees it (every check passes — the enumeration is the XSD's to catch) …
  const rej = await submitCasefile(events, port2, cf, { request: { ...request, xml_document: tampered, request_hash: sha256Hex(bytesOf(tampered)) }, at: clock.now(), prior: [], projected_note_date: null, scif_facts: scifFactsOf(REFI) });
  assert.equal(events.ofType(DU_PREFLIGHT_PASSED).length, 1, "preflight ran inline over the un-emitted request"); assert.equal(events.ofType(DU_PREFLIGHT_PASSED)[0]!.payload["inline"], true); assert.equal(events.ofType(DU_PREFLIGHT_PASSED)[0]!.payload["sha256"], sha256Hex(bytesOf(tampered)));
  // … and DU (the FAKE, xmllint) refuses it: the error submission, no ack, no casefile identifier, no outage.
  assert.equal(rej.submission.status, "error"); assert.equal(rej.submission.error_code, "DU_REJECTED"); assert.match(rej.submission.error_message!, /does not validate against the DU schema chain/); assert.equal(rej.submission.acked_at, null); assert.equal(rej.submission.du_casefile_id, null);
  assert.deepEqual(rej.rejected, { status: 400, message: rej.submission.error_message }); assert.equal(rej.outage, null); assert.equal(rej.du_casefile, null); assert.equal(rej.cutover, null); assert.equal(rej.casefile.status, "error");
  assert.equal(port2.requests.length, 0); assert.equal(port2.refused.length, 1);
  assert.equal(events.ofType("du.submitted").length, 0);
  const errored = events.ofType("du.submission.errored");
  assert.equal(errored.length, 1, "one attempt, no retry"); assert.equal(errored[0]!.payload["error_code"], "DU_REJECTED"); assert.equal(errored[0]!.payload["status"], 400); assert.equal(errored[0]!.payload["transmitted"], false); assert.match(String(errored[0]!.payload["citation"]), /23.7 rule 9/);
  assert.deepEqual(rej.events, errored, "the event rides on the result, so the command that carries it persists it");
  // And the untampered request goes through the same submit with the same port, on the emission path the bus tool takes (emitted → preflighted → gate open): the contract's six fields on the wire.
  emitDuDocumentEmitted(events, { application_id: cf.application_id, casefile_id: cf.casefile_id, submission_number: 1, document, document_id: request.document_id, du_document_id: "du-doc-t8", emitted_at: clock.now() });
  assert.equal(preflightGate(events, { document_id: request.document_id, sha256: request.request_hash }).state, "not_run", "the tampered bytes' pass is not this document's: the hash is the bytes");
  emitDuPreflight(events, { application_id: cf.application_id, du_document_id: "du-doc-t8", document_id: request.document_id, sha256: request.request_hash, casefile_id: cf.casefile_id, submission_number: 1, result: runDuPreflight(document.bytes, { du_casefile_id: null }, cf, { submission_number: 1, submission_type: "credit_only" }), ran_at: clock.now() });
  const r = await submitCasefile(events, port2, cf, { request, at: clock.now(), prior: [], projected_note_date: null, scif_facts: scifFactsOf(REFI) });
  assert.equal(r.submission.status, "acked"); assert.equal(r.submission.du_casefile_id, fakeDuCasefileId(cf.casefile_id)); assert.equal(r.rejected, null);
  assert.equal(events.ofType(DU_PREFLIGHT_PASSED).length, 2, "the gate was read off the bus; submit did not run the checks again");
  const sent = port2.requests[0]!.req;
  assert.deepEqual(Object.keys(sent).filter((k) => k !== "source").sort(), ["casefile_id", "document_bytes", "seller_number", "sha256", "submission_number", "system_id_ref"]);
  assert.equal(sent.sha256, request.request_hash); assert.equal(sha256Hex(sent.document_bytes), request.request_hash); assert.equal(sent.seller_number, CREDENTIALS.seller_number); assert.equal(sent.system_id_ref, CREDENTIALS.system_id_ref); assert.equal(sent.casefile_id, cf.casefile_id); assert.equal(sent.submission_number, 1);
  assert.deepEqual(Object.keys(duSubmitRequest(cf, request, 1)).sort(), [...Object.keys(sent)].sort());
});

test("23.7-T9: Given the refinance fixture's first submission through the FAKE port, when the ack returns `du_casefile_id`, then `applications.du_casefile_id` holds it; when the second submission's ack returns the same value, then nothing changes; when it returns a different value, then an `escalation{fnma_portal_operator}` is opened with `DU_CASEFILE_ID_CONFLICT` and the column is unchanged.", async () => {
  // The rule in memory first (the unit harness has no database: the prior acks play the column) — then the column itself, with 0127's trigger deciding.
  const clock = new FixedClock("2026-10-06T15:00:00.000Z");
  {
    const events = new MemoryEventStore(clock); const escalations = new EscalationService(events, clock);
    const cf = { casefile_id: "casefile:refi", application_id: "APP-R" };
    const w = await recordDuCasefileId(null, events, cf, { submission_number: 1, du_casefile_id: "1234567890", at: clock.now(), known: null, escalations });
    assert.equal(w.outcome, "written"); assert.equal(w.on_file, "1234567890"); assert.equal(w.events[0]!.type, "du.casefile_id.recorded"); assert.equal(w.events[0]!.payload["du_casefile_id"], "1234567890");
    const same = await recordDuCasefileId(null, events, cf, { submission_number: 2, du_casefile_id: "1234567890", at: clock.now(), known: "1234567890", escalations });
    assert.equal(same.outcome, "unchanged"); assert.deepEqual(same.events, []); assert.equal(escalations.list().length, 0);
    const other = await recordDuCasefileId(null, events, cf, { submission_number: 3, du_casefile_id: "9999999999", at: clock.now(), known: "1234567890", escalations });
    assert.equal(other.outcome, "conflict"); assert.equal(other.on_file, "1234567890"); assert.equal(other.acked, "9999999999");
    assert.equal(other.escalation!.ownerRole, "fnma_portal_operator"); assert.equal(other.escalation!.kind, "human_portal_task"); assert.equal(other.escalation!.payload["code"], "DU_CASEFILE_ID_CONFLICT"); assert.equal(other.escalation!.applicationId, "APP-R");
    assert.equal(other.events[0]!.type, "du.casefile_id.conflict"); assert.equal(other.events[0]!.payload["escalation_id"], other.escalation!.id); assert.equal(other.events[0]!.payload["overwritten"], false);
    await assert.rejects(recordDuCasefileId(null, events, cf, { submission_number: 1, du_casefile_id: "casefile:refi", at: clock.now() }), RangeError, "ours is never DU's");
  }
  if (skipDb) { console.log(`  (applications.du_casefile_id on the database skipped: ${skipDb})`); return; }
  const events = new MemoryEventStore(clock); const escalations = new EscalationService(events, clock); const port = new FakeDuPort(clock);
  const app = await newApplication();
  assert.equal(await column(app), null);
  const snapshot: UladSnapshot = { ...REFI, application_id: app };
  const cf0 = createCasefile(events, { application_id: app, ...CREDENTIALS, score_model: "classic_fico", created_at: clock.now() }).casefile;
  // The store as src/runtime/app.ts hands it to the tool: the read on the pool, the UPDATE deferred and committed with the command — flushed here as the runtime's commit does.
  const deferred: ((q: Queryable) => Promise<void>)[] = [];
  const store = { read: db!, defer: (fn: (q: Queryable) => Promise<void>) => { deferred.push(fn); } };
  const commit = async (): Promise<number> => { const fns = deferred.splice(0); await db!.tx(async (q) => { for (const fn of fns) await fn(q); }); return fns.length; };
  const submit = async (cf: typeof cf0, prior: Parameters<typeof submitCasefile>[3]["prior"], p: FakeDuPort, at: string, s: UladSnapshot = snapshot) => {
    clock.set(at);
    const du_casefile_id = prior.find((x) => x.du_casefile_id)?.du_casefile_id ?? null;
    const request = buildDuRequest(cf, { submission_type: "credit_only", reason: prior.length ? "data_change" : "initial", built_at: at, snapshot: s, graph: refinanceFixtureGraph(s, { du_casefile_id }), prior_submission_number: prior.at(-1)?.submission_number ?? null });
    return submitCasefile(events, p, cf, { request, at, prior, projected_note_date: null, scif_facts: scifFactsOf(snapshot), escalations, db: store });
  };
  // An application that is not a row is refused before the port is touched — never after an ack.
  const ghost = createCasefile(events, { application_id: "00000000-0000-4000-8000-00000000dead", ...CREDENTIALS, score_model: "classic_fico", created_at: clock.now() }).casefile;
  await assert.rejects(submit(ghost, [], port, "2026-10-06T14:00:00.000Z", { ...snapshot, application_id: ghost.application_id }), (e: unknown) => e instanceof DuRefused && e.error_code === "APPLICATION_ROW_MISSING" && /nothing was transmitted/.test(e.message));
  assert.equal(port.requests.length, 0); assert.equal(events.ofType("du.submitted").length, 0); assert.equal(deferred.length, 0);
  // Submission 1: the ack's identifier lands in the column — at the commit, not before it.
  const r1 = await submit(cf0, [], port, "2026-10-06T15:00:00.000Z");
  const id = r1.submission.du_casefile_id!;
  assert.match(id, /^[1-9]\d{9}$/); assert.equal(id, fakeDuCasefileId(cf0.casefile_id));
  assert.equal(r1.du_casefile!.outcome, "written"); assert.equal(await column(app), null, "nothing is written outside the command's transaction");
  assert.equal(events.ofType("du.casefile_id.recorded").length, 1); assert.equal(events.ofType("du.casefile_id.recorded")[0]!.payload["persisted"], true); assert.equal(events.ofType("du.submitted")[0]!.payload["du_casefile_id"], id);
  assert.equal(await commit(), 1); assert.equal(await column(app), id);
  assert.equal(events.ofType(DU_PREFLIGHT_PASSED).length, 1, "submit preflighted the un-emitted request itself before transmitting");
  // Submission 2: the same identifier again — nothing changes and nothing is written (the trigger's same-value no-op is never even reached).
  const r2 = await submit(r1.casefile, [r1.submission], port, "2026-10-07T15:00:00.000Z");
  assert.equal(r2.submission.submission_number, 2); assert.equal(r2.submission.du_casefile_id, id);
  assert.equal(r2.du_casefile!.outcome, "unchanged"); assert.equal(await commit(), 0); assert.equal(await column(app), id);
  assert.equal(events.ofType("du.casefile_id.recorded").length, 1); assert.equal(events.ofType("du.casefile_id.conflict").length, 0); assert.equal(escalations.list().length, 0);
  // Submission 3 acked under a different identifier: decided from the column as read before transmit — the ingest escalates, writes nothing, the column is unchanged.
  const rogue = new FakeDuPort(clock, { mint: () => "9999999999" });
  const r3 = await submit(r2.casefile, [r1.submission, r2.submission], rogue, "2026-10-08T15:00:00.000Z", { ...snapshot, loan_amount_cents: 55_000_000n });   // a data change: two identical hashes in a row are suppressed (23.1 rule 3)
  assert.equal(r3.submission.status, "acked"); assert.equal(r3.submission.du_casefile_id, "9999999999", "the ack as DU gave it, on the submission row");
  assert.equal(r3.du_casefile!.outcome, "conflict"); assert.equal(r3.du_casefile!.on_file, id); assert.equal(r3.du_casefile!.acked, "9999999999");
  assert.equal(await commit(), 0, "a conflict queues no write"); assert.equal(await column(app), id, "the column is unchanged");
  const esc = r3.du_casefile!.escalation!;
  assert.equal(esc.ownerRole, "fnma_portal_operator"); assert.equal(esc.kind, "human_portal_task"); assert.equal(esc.applicationId, app);
  assert.equal(esc.payload["code"], "DU_CASEFILE_ID_CONFLICT"); assert.equal(esc.payload["du_casefile_id_on_file"], id); assert.equal(esc.payload["du_casefile_id_acked"], "9999999999"); assert.equal(esc.payload["submission_number"], 3);
  assert.equal(escalations.list().length, 1); assert.equal(escalations.list()[0]!.id, esc.id);
  const conflict = events.ofType("du.casefile_id.conflict");
  assert.equal(conflict.length, 1); assert.equal(conflict[0]!.payload["escalation_id"], esc.id); assert.equal(conflict[0]!.payload["overwritten"], false);
  // The trigger is the backstop the ingest never bypasses: the same UPDATE by hand — or a deferred write racing a column that changed after the read — is refused with the trigger's own message and rolls the transaction back.
  await assert.rejects(db!.query(`UPDATE applications SET du_casefile_id = '9999999999' WHERE id = $1`, [app]), /DU_CASEFILE_ID_WRITE_ONCE/);
  store.defer(async (q) => { await q.query(`UPDATE applications SET du_casefile_id = $2 WHERE id = $1`, [app, "9999999999"]); });
  await assert.rejects(commit(), /DU_CASEFILE_ID_WRITE_ONCE/);
  assert.equal(await column(app), id);
});

test("23.7-T10: Given a preflight refusal, when 23.1's `submit` is invoked for that document, then it is refused with the preflight code and no `du.submitted` event exists.", async () => {
  const clock = new FixedClock("2026-10-06T15:00:00.000Z"); const events = new MemoryEventStore(clock);
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["23.7"] });
  const port = new FakeDuPort(clock);
  const cf = createCasefile(events, { application_id: REFI.application_id, ...CREDENTIALS, score_model: "classic_fico", created_at: clock.now() }).casefile;
  const scif_facts = { borrowers: REFI.borrowers.map((b) => ({ id: b.borrower_id, scif_presented_at: "2026-10-05T16:00:00.000Z" })) };
  // The request is the document (23.6); the emission arms the gate; a dangling arc in the bytes (the corpus's own case) makes preflight refuse it.
  const request = buildDuRequest(cf, { submission_type: "credit_only", reason: "initial", built_at: clock.now(), snapshot: REFI, graph: refinanceFixtureGraph(REFI) });
  const emitted = emitDuDocumentEmitted(events, { application_id: cf.application_id, casefile_id: cf.casefile_id, submission_number: 1, document: { bytes: new TextEncoder().encode(request.xml_document), sha256: request.request_hash, stats: { container_count: 0, relationship_count: 0, borrower_count: 2, disputed_arcs_skipped: 0 }, labels: new Map(), gaps: [] }, document_id: request.document_id, du_document_id: "du-doc-refi", emitted_at: clock.now() });
  assert.equal(emitted.type, "du.document.emitted"); assert.equal(timers.byCode("SM_DU_PREFLIGHT_GATE")[0]!.status, "armed");
  // Held, not yet run: submit is refused with the gate's own code — the document was emitted and nobody preflighted it.
  await assert.rejects(submitCasefile(events, port, cf, { request, at: clock.now(), prior: [], projected_note_date: null, scif_facts }), (e: unknown) => e instanceof DuRefused && e.error_code === "SM_DU_PREFLIGHT_GATE");
  const bad = mutate(request.xml_document, /(<RELATIONSHIP [^>]*xlink:to=")([A-Z_0-9]+)(")/, "$1NOBODY_9$3");
  const refused = runDuPreflight(bad, refinanceFixtureGraph(REFI), cf, { submission_number: 1, submission_type: "credit_only" });
  assert.equal(refused.refusal?.code, "DU_PREFLIGHT_DANGLING_ARC");
  const e = emitDuPreflight(events, { application_id: cf.application_id, du_document_id: "du-doc-refi", document_id: request.document_id, sha256: request.request_hash, casefile_id: cf.casefile_id, submission_number: 1, result: refused, ran_at: clock.now() });
  assert.equal(e.type, DU_PREFLIGHT_REFUSED); assert.equal(e.payload["code"], "DU_PREFLIGHT_DANGLING_ARC"); assert.equal(e.payload["document_id"], "du-doc-refi"); assert.match(String(e.payload["xpath"]), /RELATIONSHIP/); assert.match(String(e.payload["rule"]), /rule 1/);
  assert.equal(timers.byCode("SM_DU_PREFLIGHT_GATE")[0]!.status, "armed", "a refusal does not satisfy the gate");
  // 23.1's submit reads the gate off the bus and refuses with the preflight code; nothing reached the port; no du.submitted.
  await assert.rejects(submitCasefile(events, port, cf, { request, at: clock.now(), prior: [], projected_note_date: null, scif_facts }), (e: unknown) => e instanceof DuRefused && e.error_code === "DU_PREFLIGHT_DANGLING_ARC" && /SM_DU_PREFLIGHT_GATE/.test(e.citation) && /NOBODY_9/.test(e.message));
  // The same with the result handed to submit directly.
  await assert.rejects(submitCasefile(events, port, cf, { request, at: clock.now(), prior: [], projected_note_date: null, scif_facts, preflight: refused }), (e: unknown) => e instanceof DuRefused && e.error_code === "DU_PREFLIGHT_DANGLING_ARC");
  assert.equal(port.requests.length, 0, "never transmitted");
  assert.equal(events.ofType("du.submitted").length, 0, "no du.submitted event exists");
  assert.equal(events.ofType("command.refused").length + events.ofType("du.submission.errored").length, 0);
  // A later pass over the (unmutated) document opens the gate and the same submit proceeds.
  const passed = runDuPreflight(request.xml_document, refinanceFixtureGraph(REFI), cf, { submission_number: 1, submission_type: "credit_only" });
  assert.ok(passed.passed, passed.refusal?.detail);
  emitDuPreflight(events, { application_id: cf.application_id, du_document_id: "du-doc-refi", document_id: request.document_id, sha256: request.request_hash, casefile_id: cf.casefile_id, submission_number: 1, result: passed, ran_at: clock.now() });
  assert.equal(timers.byCode("SM_DU_PREFLIGHT_GATE")[0]!.status, "satisfied");
  const r = await submitCasefile(events, port, cf, { request, at: clock.now(), prior: [], projected_note_date: null, scif_facts });
  assert.equal(r.submission.status, "acked"); assert.equal(events.ofType("du.submitted").length, 1); assert.equal(port.requests.length, 1);
  // A request nobody emitted on the bus (no gate armed) is not open either: submit runs the checks itself, and a refusal is the preflight code, nothing transmitted.
  const events2 = new MemoryEventStore(clock); const port2 = new FakeDuPort(clock);
  const cf2 = createCasefile(events2, { application_id: REFI.application_id, ...CREDENTIALS, score_model: "classic_fico", created_at: clock.now() }).casefile;
  assert.equal(preflightGate(events2, { document_id: request.document_id, sha256: request.request_hash }).state, "not_armed"); assert.equal(preflightGate(events2, { document_id: request.document_id, sha256: request.request_hash }).open, false);
  await assert.rejects(submitCasefile(events2, port2, cf2, { request: { ...request, xml_document: bad, request_hash: sha256Hex(new TextEncoder().encode(bad)) }, at: clock.now(), prior: [], projected_note_date: null, scif_facts }), (e: unknown) => e instanceof DuRefused && e.error_code === "DU_PREFLIGHT_DANGLING_ARC" && /NOBODY_9/.test(e.message));
  assert.equal(events2.ofType(DU_PREFLIGHT_REFUSED).length, 1); assert.equal(events2.ofType(DU_PREFLIGHT_REFUSED)[0]!.payload["inline"], true); assert.equal(events2.ofType(DU_PREFLIGHT_REFUSED)[0]!.payload["code"], "DU_PREFLIGHT_DANGLING_ARC");
  assert.equal(port2.requests.length, 0); assert.equal(events2.ofType("du.submitted").length, 0);
  // The database half: du_preflight_results — every run recorded against the emitted document, passing or not, the latest read back by any of the three ids; append-only (0136).
  if (skipDb) { console.log(`  (du_preflight_results on the database skipped: ${skipDb})`); return; }
  const app = await newApplication();
  const sample = loadSample("DI-C01"); const document = assembleDuDocument(sample.graph, sample.casefile, sample.submission);
  const row = await db!.tx((q) => persistDuDocument(q, { application_id: app, casefile_id: sample.casefile.casefile_id, submission_number: 1, document, emitted_at: "2026-10-06T15:00:00.000Z" }));
  const passedRun = runDuPreflight(document.bytes, sample.graph, { ...sample.casefile, ...CREDENTIALS }, sample.submission);
  const refusedRun = runDuPreflight(mutate(text(document.bytes), /(<RELATIONSHIP [^>]*xlink:to=")([A-Z_0-9]+)(")/, "$1NOBODY_9$3"), sample.graph, { ...sample.casefile, ...CREDENTIALS }, sample.submission);
  assert.ok(passedRun.passed); assert.equal(refusedRun.refusal?.code, "DU_PREFLIGHT_DANGLING_ARC");
  const p1 = await db!.tx((q) => persistDuPreflight(q, { application_id: app, du_document_id: row.du_document_id, document_id: row.document_id, sha256: row.sha256, casefile_id: sample.casefile.casefile_id, submission_number: 1, result: passedRun, ran_at: "2026-10-06T15:00:00.000Z" }));
  const p2 = await db!.tx((q) => persistDuPreflight(q, { application_id: app, du_document_id: row.du_document_id, document_id: row.document_id, sha256: row.sha256, casefile_id: sample.casefile.casefile_id, submission_number: 1, result: refusedRun, ran_at: "2026-10-06T15:05:00.000Z" }));
  assert.notEqual(p1.id, p2.id);
  assert.equal((await db!.query<{ c: bigint }>(`SELECT count(*)::bigint AS c FROM du_preflight_results WHERE document_id = $1`, [row.du_document_id]))[0]!.c, 2n, "every run is recorded, passing or not");
  for (const by of [{ du_document_id: row.du_document_id }, { document_id: row.document_id }, { application_id: app }]) {
    const got = (await readDuPreflight(db!, by))!;
    assert.ok(got, JSON.stringify(by));
    assert.equal(got.id, p2.id, `${JSON.stringify(by)}: the latest row is the refused run`); assert.equal(got.passed, false);
    assert.equal(got.du_document_id, row.du_document_id); assert.equal(got.document_id, row.document_id); assert.equal(got.application_id, app); assert.equal(got.casefile_id, sample.casefile.casefile_id); assert.equal(got.submission_number, 1);
    assert.equal(got.checks.length, DU_PREFLIGHT_CODES.length); assert.equal(got.checks.length, 14); assert.deepEqual(got.checks.map((c) => c.code), [...DU_PREFLIGHT_CODES]);
    assert.equal(got.checks.find((c) => !c.passed)?.code, "DU_PREFLIGHT_DANGLING_ARC"); assert.match(got.checks.find((c) => !c.passed)!.detail!, /NOBODY_9/);
    assert.match(got.ran_at, /^2026-10-06 15:05/);
  }
  const first = (await db!.query<{ passed: boolean; n: number }>(`SELECT passed, jsonb_array_length(checks) AS n FROM du_preflight_results WHERE id = $1`, [p1.id]))[0]!;
  assert.equal(first.passed, true); assert.equal(Number(first.n), 14);
  await assert.rejects(db!.query(`UPDATE du_preflight_results SET passed = true WHERE id = $1`, [p2.id]), /append-only/);
  await assert.rejects(db!.query(`DELETE FROM du_preflight_results WHERE id = $1`, [p1.id]), /append-only/);
  assert.equal((await db!.query<{ c: bigint }>(`SELECT count(*)::bigint AS c FROM du_preflight_results WHERE document_id = $1`, [row.du_document_id]))[0]!.c, 2n);
});

test("23.7-T11: Given a wage income item whose `EmploymentIncomeIndicator` is true and which has no `CURRENT_INCOME_ITEM_IsAssociatedWith_EMPLOYER` arc, then `DU_PREFLIGHT_EMPLOYER_ARC` naming the income item's label.", () => {
  const g = refinanceFixtureGraph(REFI);
  const noArc: DuGraph = { ...g, arcs: g.arcs.filter((a) => a.id !== "earns:income:B1") };
  const doc = assembleDuDocument(noArc, CASEFILE, FIRST);
  const label = doc.labels.get("income:B1")!;
  assert.match(text(doc.bytes), /<EmploymentIncomeIndicator>true<\/EmploymentIncomeIndicator>/);
  const r = runDuPreflight(doc.bytes, noArc, CASEFILE, FIRST);
  assert.equal(r.refusal?.code, "DU_PREFLIGHT_EMPLOYER_ARC");
  assert.ok(r.refusal!.detail.startsWith(`${label}: EmploymentIncomeIndicator = true and no CURRENT_INCOME_ITEM_IsAssociatedWith_EMPLOYER arc`), r.refusal!.detail);
  assert.match(r.refusal!.xpath, /CURRENT_INCOME_ITEM$/);
  // The reverse — an employer arc on an item whose indicator is not true — is the same code.
  const flipped: DuGraph = { ...g, containers: g.containers.map((c) => (c.id === "income:B2" ? { ...c, values: { ...c.values, "CURRENT_INCOME_ITEM_DETAIL/EmploymentIncomeIndicator": false } } : c)) };
  const doc2 = assembleDuDocument(flipped, CASEFILE, FIRST);
  const r2 = runDuPreflight(doc2.bytes, flipped, CASEFILE, FIRST);
  assert.equal(r2.refusal?.code, "DU_PREFLIGHT_EMPLOYER_ARC"); assert.match(r2.refusal!.detail, new RegExp(`^${doc2.labels.get("income:B2")}: 1 employer arc\\(s\\) on an item whose EmploymentIncomeIndicator is not true`));
  assert.ok(runDuPreflight(assembleDuDocument(g, CASEFILE, FIRST).bytes, g, CASEFILE, FIRST).passed, "the fixture's items each carry their employer arc");
});

test("23.7-T12: Given a casefile whose `seller_number` is empty, then `DU_PREFLIGHT_CREDENTIALS` before any other check runs.", () => {
  // The bytes carry a dangling arc as well — and are never looked at: the credentials check is the only one recorded.
  const bad = mutate(good(), /(<RELATIONSHIP [^>]*xlink:to=")([A-Z_0-9]+)(")/, "$1NOBODY_9$3");
  const r = runDuPreflight(bad, SAMPLE_GRAPH, { ...CASEFILE, seller_number: "" }, FIRST);
  assert.equal(r.passed, false);
  assert.equal(r.refusal?.code, "DU_PREFLIGHT_CREDENTIALS"); assert.equal(r.refusal!.xpath, "du_casefiles.seller_number"); assert.match(r.refusal!.detail, /no other check ran/);
  assert.deepEqual(r.checks.map((c) => c.code), ["DU_PREFLIGHT_CREDENTIALS"], "before any other check runs");
  assert.equal(DU_PREFLIGHT_CODES[0], "DU_PREFLIGHT_CREDENTIALS");
  // Whitespace is empty; every one of the three is asserted; a whole 23.1 casefile satisfies the check.
  assert.equal(runDuPreflight(bad, SAMPLE_GRAPH, { ...CASEFILE, seller_number: "   " }, FIRST).refusal?.code, "DU_PREFLIGHT_CREDENTIALS");
  assert.match(runDuPreflight(bad, SAMPLE_GRAPH, { ...CASEFILE, system_id_ref: null, tsp_product_ref: undefined }, FIRST).refusal!.detail, /du_casefiles.system_id_ref, du_casefiles.tsp_product_ref empty/);
  // Bytes that are not even XML are never parsed when the credentials fail; with credentials they are refused by the reader, not silently passed.
  assert.equal(runDuPreflight("not xml", SAMPLE_GRAPH, { ...CASEFILE, seller_number: "" }, FIRST).refusal?.code, "DU_PREFLIGHT_CREDENTIALS");
  assert.throws(() => runDuPreflight("not xml", SAMPLE_GRAPH, CASEFILE, FIRST), /XML/);
  const events = new MemoryEventStore(new FixedClock("2026-10-06T15:00:00.000Z"));
  const cf = createCasefile(events, { application_id: "APP-R", ...CREDENTIALS, score_model: "classic_fico", created_at: "2026-10-06T15:00:00.000Z" }).casefile;
  assert.ok(runDuPreflight(good(), SAMPLE_GRAPH, cf, { submission_number: 1, submission_type: "credit_only" }).checks[0]!.passed);
});
